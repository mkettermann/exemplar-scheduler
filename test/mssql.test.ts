import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * O driver `mssql` inteiro é falso aqui: o que se prova é o **wrapper** —
 * pool único, memoização da conexão, e o contrato de `verificarSaudeDb` de
 * nunca lançar. Que o SQL Server aceite a conexão é outra afirmação, e só um
 * teste de integração a sustenta (ver `docs/09-testes.md`, upgrades).
 *
 * `pool` e `conectando` são estado de módulo, então cada teste recarrega
 * `mssql.ts` com `vi.resetModules()` — sem isso, o pool conectado no primeiro
 * teste vazaria para os seguintes e a memoização nunca seria exercitada.
 * Ver `docs/04-banco-de-dados.md`.
 */
const mocks = vi.hoisted(() => ({
  /** Espião do `new`: registra a configuração recebida pelo driver. */
  criouPool: vi.fn(),
  conectar: vi.fn(),
  query: vi.fn(),
  poolConectado: {
    on: vi.fn(),
    request: vi.fn(),
    close: vi.fn(),
  },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('mssql', () => ({
  default: {
    // `new` exige classe: o vitest 5 recusa `vi.fn()` como construtor.
    ConnectionPool: class {
      constructor(configuracao: unknown) {
        mocks.criouPool(configuracao);
      }

      connect() {
        return mocks.conectar();
      }
    },
    NVarChar: 'NVarChar',
    Int: 'Int',
  },
}));

vi.mock('../src/logger/logger.js', () => ({ logger: mocks.logger }));

/** Devolve um `mssql.ts` recém-carregado, sem pool herdado de outro teste. */
async function carregarModuloDb() {
  vi.resetModules();
  return import('../src/db/mssql.js');
}

/** Configuração com que o driver foi instanciado na n-ésima conexão. */
function configuracaoDaConexao(indice = 0): Record<string, any> {
  return mocks.criouPool.mock.calls[indice]?.[0] as Record<string, any>;
}

beforeEach(() => {
  mocks.conectar.mockResolvedValue(mocks.poolConectado);
  mocks.poolConectado.request.mockReturnValue({ query: mocks.query });
  mocks.poolConectado.close.mockResolvedValue(undefined);
  mocks.query.mockResolvedValue({ recordset: [{ ok: 1 }] });
});

describe('obterPoolDb', () => {
  it('conecta uma vez e reaproveita o pool nas chamadas seguintes', async () => {
    const { obterPoolDb } = await carregarModuloDb();

    const primeiro = await obterPoolDb();
    const segundo = await obterPoolDb();

    expect(primeiro).toBe(mocks.poolConectado);
    expect(segundo).toBe(primeiro);
    expect(mocks.criouPool).toHaveBeenCalledTimes(1);
  });

  it('dois jobs disparados no boot esperam a mesma conexão', async () => {
    const { obterPoolDb } = await carregarModuloDb();

    const [umJob, outroJob] = await Promise.all([obterPoolDb(), obterPoolDb()]);

    expect(mocks.criouPool).toHaveBeenCalledTimes(1);
    expect(mocks.conectar).toHaveBeenCalledTimes(1);
    expect(umJob).toBe(outroJob);
  });

  it('monta a configuração a partir do ambiente validado', async () => {
    const { obterPoolDb } = await carregarModuloDb();

    await obterPoolDb();

    expect(configuracaoDaConexao()).toMatchObject({
      server: 'localhost',
      port: 1433,
      database: 'scheduler_test',
      user: 'test',
      password: 'test',
    });
  });

  it('só confia em certificado do servidor fora de produção', async () => {
    const { obterPoolDb } = await carregarModuloDb();

    await obterPoolDb();

    expect(configuracaoDaConexao().options.trustServerCertificate).toBe(true);
  });

  /**
   * A asserção compara com `ambiente.DB_ENCRYPT` em vez de um literal de
   * propósito: hoje `DB_ENCRYPT=false` resulta em `true`, porque o campo ainda
   * usa `z.coerce.boolean()` — a armadilha descrita em
   * `docs/02-configuracao-de-ambiente.md`. O que cabe a este módulo é
   * repassar o valor decidido lá, e é só isso que se prova aqui; o dia em que
   * o parser explícito for aplicado, este teste continua valendo.
   */
  it('repassa ao driver o valor de TLS que o ambiente decidiu', async () => {
    const { obterPoolDb } = await carregarModuloDb();
    const { ambiente } = await import('../src/config/env.js');

    await obterPoolDb();

    expect(configuracaoDaConexao().options.encrypt).toBe(ambiente.DB_ENCRYPT);
  });

  it('falha de conexão não trava o processo: a próxima chamada tenta de novo', async () => {
    mocks.conectar.mockRejectedValueOnce(new Error('servidor inacessível'));
    const { obterPoolDb } = await carregarModuloDb();

    await expect(obterPoolDb()).rejects.toThrow('servidor inacessível');
    const pool = await obterPoolDb();

    expect(pool).toBe(mocks.poolConectado);
    expect(mocks.criouPool).toHaveBeenCalledTimes(2);
  });

  it('anuncia a conexão no log', async () => {
    const { obterPoolDb } = await carregarModuloDb();

    await obterPoolDb();

    expect(mocks.logger.info).toHaveBeenCalledWith('Conectado ao MSSQL');
  });

  it('erro emitido pelo pool é logado, não derruba o processo', async () => {
    const { obterPoolDb } = await carregarModuloDb();
    await obterPoolDb();

    expect(mocks.poolConectado.on).toHaveBeenCalledWith(
      'error',
      expect.any(Function),
    );

    const tratador = mocks.poolConectado.on.mock.calls[0]?.[1] as (
      erro: Error,
    ) => void;
    const erro = new Error('conexão derrubada pelo servidor');

    expect(() => tratador(erro)).not.toThrow();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      { err: erro },
      'Erro no pool de conexão MSSQL',
    );
  });
});

describe('fecharPoolDb', () => {
  it('fecha o pool aberto e permite reconectar depois', async () => {
    const { obterPoolDb, fecharPoolDb } = await carregarModuloDb();
    await obterPoolDb();

    await fecharPoolDb();

    expect(mocks.poolConectado.close).toHaveBeenCalledTimes(1);

    await obterPoolDb();

    expect(mocks.criouPool).toHaveBeenCalledTimes(2);
  });

  it('é inofensivo quando nunca houve conexão — o shutdown não depende dela', async () => {
    const { fecharPoolDb } = await carregarModuloDb();

    await expect(fecharPoolDb()).resolves.toBeUndefined();
    expect(mocks.poolConectado.close).not.toHaveBeenCalled();
  });
});

describe('verificarSaudeDb', () => {
  it('responde ok com a latência medida quando o banco atende', async () => {
    const { verificarSaudeDb } = await carregarModuloDb();

    const saude = await verificarSaudeDb();

    expect(saude.ok).toBe(true);
    expect(saude.latenciaMs).toBeTypeOf('number');
    expect(saude.latenciaMs).toBeGreaterThanOrEqual(0);
    expect(saude.erro).toBeUndefined();
  });

  it('usa um ping barato, não uma consulta de negócio', async () => {
    const { verificarSaudeDb } = await carregarModuloDb();

    await verificarSaudeDb();

    expect(mocks.query).toHaveBeenCalledWith('SELECT 1 AS ok');
  });

  it('devolve o erro no corpo em vez de lançar — é o que a rota espera', async () => {
    mocks.query.mockRejectedValue(new Error('Login failed for user'));
    const { verificarSaudeDb } = await carregarModuloDb();

    const saude = await verificarSaudeDb();

    expect(saude).toMatchObject({ ok: false, erro: 'Login failed for user' });
  });

  it('falha ao obter o pool também vira resposta, não exceção', async () => {
    mocks.conectar.mockRejectedValue(new Error('servidor inacessível'));
    const { verificarSaudeDb } = await carregarModuloDb();

    const saude = await verificarSaudeDb();

    expect(saude).toMatchObject({ ok: false, erro: 'servidor inacessível' });
  });

  it('o que é lançado sem ser Error ainda sai legível no campo erro', async () => {
    mocks.query.mockRejectedValue('driver devolveu string');
    const { verificarSaudeDb } = await carregarModuloDb();

    const saude = await verificarSaudeDb();

    expect(saude).toMatchObject({ ok: false, erro: 'driver devolveu string' });
  });
});

describe('verificarSaudeDb — prazo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    return () => {
      vi.useRealTimers();
    };
  });

  it('desiste no prazo pedido quando o banco não responde', async () => {
    mocks.query.mockReturnValue(new Promise(() => { }));
    const { verificarSaudeDb } = await carregarModuloDb();

    const emAndamento = verificarSaudeDb(500);
    await vi.advanceTimersByTimeAsync(500);

    await expect(emAndamento).resolves.toMatchObject({
      ok: false,
      erro: 'Timeout de 500ms ao consultar o banco',
    });
  });

  it('sem argumento, vale o HEALTH_DB_TIMEOUT_MS do ambiente', async () => {
    mocks.query.mockReturnValue(new Promise(() => { }));
    const { verificarSaudeDb } = await carregarModuloDb();

    const emAndamento = verificarSaudeDb();
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(emAndamento).resolves.toMatchObject({
      erro: 'Timeout de 3000ms ao consultar o banco',
    });
  });

  it('ainda está esperando um milissegundo antes do prazo', async () => {
    mocks.query.mockReturnValue(new Promise(() => { }));
    const { verificarSaudeDb } = await carregarModuloDb();
    let concluiu = false;

    void verificarSaudeDb(500).then(() => {
      concluiu = true;
    });
    await vi.advanceTimersByTimeAsync(499);

    expect(concluiu).toBe(false);
  });

  it('libera o temporizador quando o banco responde a tempo', async () => {
    const { verificarSaudeDb } = await carregarModuloDb();

    await verificarSaudeDb(500);

    expect(vi.getTimerCount()).toBe(0);
  });
});
