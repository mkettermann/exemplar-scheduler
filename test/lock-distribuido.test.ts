import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * O lock é testado contra um `mssql` falso: o que se prova aqui é o **fluxo**
 * — quem faz commit, quem faz rollback, quando a ação é pulada — e os
 * parâmetros enviados ao `sp_getapplock`. Que o `sp_getapplock` de fato exclua
 * duas instâncias é afirmação sobre o SQL Server, e só um teste de integração
 * com banco real pode sustentá-la (ver `docs/09-testes.md`, upgrades).
 * Ver `docs/06-lock-distribuido.md`.
 */
const mocks = vi.hoisted(() => ({
  obterPoolDb: vi.fn(),
  /** Espiões do `new`: registram com que argumento cada objeto foi criado. */
  criouTransacao: vi.fn(),
  criouRequisicao: vi.fn(),
  transacao: {
    begin: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
  },
  requisicao: {
    input: vi.fn(),
    query: vi.fn(),
  },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('../src/db/mssql.js', () => ({
  obterPoolDb: mocks.obterPoolDb,
  fecharPoolDb: vi.fn(),
  verificarSaudeDb: vi.fn(),
  sql: {
    // `new` exige classe: o vitest 5 recusa `vi.fn()` como construtor.
    Transaction: class {
      constructor(pool: unknown) {
        mocks.criouTransacao(pool);
        return mocks.transacao;
      }
    },
    Request: class {
      constructor(transacao: unknown) {
        mocks.criouRequisicao(transacao);
        return mocks.requisicao;
      }
    },
    NVarChar: 'NVarChar',
    Int: 'Int',
  },
}));

vi.mock('../src/logger/logger.js', () => ({ logger: mocks.logger }));

import { executarComLock } from '../src/scheduler/lock.js';

const POOL = { identificador: 'pool-unico' };

/** Retorno do `SELECT @result` do applock: >= 0 concede, < 0 recusa. */
function applockResponde(result: number | undefined): void {
  mocks.requisicao.query.mockResolvedValue({
    recordset: result === undefined ? [] : [{ result }],
  });
}

/** Parâmetros passados ao `.input(...)`, no formato `{ nome: valor }`. */
function parametrosEnviados(): Record<string, unknown> {
  return Object.fromEntries(
    mocks.requisicao.input.mock.calls.map(([nome, , valor]) => [nome, valor]),
  );
}

beforeEach(() => {
  mocks.obterPoolDb.mockResolvedValue(POOL);
  mocks.transacao.begin.mockResolvedValue(undefined);
  mocks.transacao.commit.mockResolvedValue(undefined);
  mocks.transacao.rollback.mockResolvedValue(undefined);
  mocks.requisicao.input.mockReturnValue(mocks.requisicao);
  applockResponde(0);
});

describe('executarComLock — lock concedido', () => {
  it('abre transação sobre o pool único do processo', async () => {
    await executarComLock('cobranca', async () => undefined);

    expect(mocks.obterPoolDb).toHaveBeenCalledTimes(1);
    expect(mocks.criouTransacao).toHaveBeenCalledWith(POOL);
    expect(mocks.criouRequisicao).toHaveBeenCalledWith(mocks.transacao);
    expect(mocks.transacao.begin).toHaveBeenCalledTimes(1);
  });

  it('executa a ação e devolve o resultado dela', async () => {
    const acao = vi.fn(async () => 42);

    const retorno = await executarComLock('cobranca', acao);

    expect(acao).toHaveBeenCalledTimes(1);
    expect(retorno).toEqual({ executou: true, resultado: 42 });
  });

  it('faz commit depois da ação, nunca antes', async () => {
    const ordem: string[] = [];
    mocks.transacao.commit.mockImplementation(async () => {
      ordem.push('commit');
    });

    await executarComLock('cobranca', async () => {
      ordem.push('acao');
    });

    expect(ordem).toEqual(['acao', 'commit']);
    expect(mocks.transacao.rollback).not.toHaveBeenCalled();
  });

  it('trata como concedido o retorno 1, que é concessão após espera', async () => {
    applockResponde(1);
    const acao = vi.fn(async () => undefined);

    const retorno = await executarComLock('cobranca', acao);

    expect(acao).toHaveBeenCalledTimes(1);
    expect(retorno.executou).toBe(true);
  });
});

describe('executarComLock — pedido do applock', () => {
  it('usa o nome do job como recurso, prefixado, para não colidir', async () => {
    await executarComLock('cobranca', async () => undefined);

    expect(parametrosEnviados().Resource).toBe('job:cobranca');
  });

  it('pede lock exclusivo preso à transação', async () => {
    await executarComLock('cobranca', async () => undefined);

    expect(parametrosEnviados()).toMatchObject({
      LockMode: 'Exclusive',
      LockOwner: 'Transaction',
    });
  });

  it('não espera pelo lock: timeout zero é o que faz a execução ser pulada', async () => {
    await executarComLock('cobranca', async () => undefined);

    expect(parametrosEnviados().LockTimeout).toBe(0);
  });

  it('o lock é do sp_getapplock, não de uma tabela de controle', async () => {
    await executarComLock('cobranca', async () => undefined);

    expect(String(mocks.requisicao.query.mock.calls[0]?.[0])).toContain(
      'sp_getapplock',
    );
  });
});

describe('executarComLock — lock negado', () => {
  beforeEach(() => {
    applockResponde(-1);
  });

  it('não executa a ação e sinaliza que pulou', async () => {
    const acao = vi.fn(async () => undefined);

    const retorno = await executarComLock('cobranca', acao);

    expect(acao).not.toHaveBeenCalled();
    expect(retorno).toEqual({ executou: false });
  });

  it('desfaz a transação em vez de segurá-la aberta', async () => {
    await executarComLock('cobranca', async () => undefined);

    expect(mocks.transacao.rollback).toHaveBeenCalledTimes(1);
    expect(mocks.transacao.commit).not.toHaveBeenCalled();
  });

  it('avisa no log qual job foi pulado', async () => {
    await executarComLock('cobranca', async () => undefined);

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { job: 'cobranca' },
      expect.stringContaining('pulando'),
    );
  });

  it('recordset vazio é tratado como negado, não como concedido', async () => {
    applockResponde(undefined);
    const acao = vi.fn(async () => undefined);

    const retorno = await executarComLock('cobranca', acao);

    expect(acao).not.toHaveBeenCalled();
    expect(retorno).toEqual({ executou: false });
  });
});

describe('executarComLock — ação que falha', () => {
  it('desfaz a transação e relança, para o runner classificar o erro', async () => {
    const erro = new Error('fornecedor fora do ar');

    await expect(
      executarComLock('cobranca', async () => {
        throw erro;
      }),
    ).rejects.toThrow(erro);

    expect(mocks.transacao.rollback).toHaveBeenCalledTimes(1);
    expect(mocks.transacao.commit).not.toHaveBeenCalled();
  });

  it('desfaz a transação também quando a própria consulta do lock falha', async () => {
    mocks.requisicao.query.mockRejectedValue(new Error('conexão perdida'));

    await expect(
      executarComLock('cobranca', async () => undefined),
    ).rejects.toThrow('conexão perdida');

    expect(mocks.transacao.rollback).toHaveBeenCalledTimes(1);
  });

  it('rollback que também falha não esconde o erro original — vai para o log', async () => {
    const erroDaAcao = new Error('fornecedor fora do ar');
    const erroDoRollback = new Error('transação já abortada pelo servidor');
    mocks.transacao.rollback.mockRejectedValue(erroDoRollback);

    await expect(
      executarComLock('cobranca', async () => {
        throw erroDaAcao;
      }),
    ).rejects.toThrow(erroDaAcao);

    expect(mocks.logger.error).toHaveBeenCalledWith(
      { job: 'cobranca', err: erroDoRollback },
      'Falha no rollback da transação do lock',
    );
  });
});
