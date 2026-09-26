import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { DefinicaoJob } from '../src/scheduler/job.types.js';

/**
 * O job-runner é exercitado pelo callback que ele entrega ao node-schedule —
 * é assim que ele roda em produção, e `executarJob` não é exportado de
 * propósito. Lock, logger e scheduler são mockados; nada aqui abre conexão,
 * porta ou espera relógio real. Ver `docs/09-testes.md` e `docs/05-scheduler.md`.
 *
 * O desfecho de cada execução sai em uma linha só, em texto puro. A asserção
 * usa `stringMatching` com a duração em `\d+ms`, porque o número varia entre
 * máquinas — todo o resto da linha é contrato e é verificado por inteiro.
 */
const mocks = vi.hoisted(() => ({
  executarComLock: vi.fn(),
  scheduleJob: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('../src/scheduler/lock.js', () => ({
  executarComLock: mocks.executarComLock,
}));

vi.mock('../src/logger/logger.js', () => ({ logger: mocks.logger }));

vi.mock('node-schedule', () => ({
  default: { scheduleJob: mocks.scheduleJob },
}));

import { registrarJob } from '../src/scheduler/job-runner.js';

const JOB_DO_SCHEDULER = { name: 'job-falso' };

function jobFalso(sobrescrever: Partial<DefinicaoJob> = {}): DefinicaoJob {
  return {
    nome: 'cobranca',
    ambientes: ['hml'],
    agendamento: '*/5 * * * *',
    tempoLimiteMs: 3_000,
    executar: vi.fn(async () => { }),
    ...sobrescrever,
  };
}

/** Registra o job e devolve o callback que o node-schedule dispararia. */
function registrarECapturarDisparo(job: DefinicaoJob): () => void {
  registrarJob(job);
  const ultimaChamada = mocks.scheduleJob.mock.calls.at(-1);
  return ultimaChamada?.[2] as () => void;
}

/**
 * Espera o ciclo que o disparo abriu. O callback do node-schedule é síncrono
 * (o runner solta a promise com `void`), então o teste a retoma pela mesma via
 * que o runner usa: o retorno de `executarComLock`.
 */
async function aguardarCiclo(): Promise<void> {
  const ultimoResultado = mocks.executarComLock.mock.results.at(-1);
  await Promise.resolve(ultimoResultado?.value).catch(() => { });
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * A linha de log de cada chamada. No formato do pino, ela é o primeiro
 * argumento quando vem sozinha e o segundo quando vem depois do objeto de
 * campos — é o caso das linhas de falha, que carregam o `err`.
 */
function linhasDe(espiao: Mock): string[] {
  return espiao.mock.calls.map(([primeiro, segundo]) =>
    String(typeof primeiro === 'string' ? primeiro : segundo),
  );
}

/**
 * Deixa a cadeia de promises andar sem esperar o fim do ciclo. Usado quando o
 * ciclo **não deve** terminar ainda — o lock preso depois de um timeout.
 */
async function esvaziarMicrotarefas(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

/** Promise controlada pelo teste, para decidir quando o handler termina. */
function handlerControlado() {
  let resolver!: () => void;
  let rejeitar!: (erro: unknown) => void;
  const promessa = new Promise<void>((res, rej) => {
    resolver = res;
    rejeitar = rej;
  });

  return { executar: vi.fn(() => promessa), resolver, rejeitar };
}

beforeEach(() => {
  mocks.scheduleJob.mockReturnValue(JOB_DO_SCHEDULER);
  mocks.executarComLock.mockImplementation(
    async (_nome: string, acao: () => Promise<unknown>) => ({
      executou: true,
      resultado: await acao(),
    }),
  );
});

describe('registrarJob', () => {
  it('registra no node-schedule com o nome e o agendamento declarados', () => {
    const job = jobFalso({ nome: 'faturamento', agendamento: '0 3 * * *' });

    const registrado = registrarJob(job);

    expect(mocks.scheduleJob).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleJob.mock.calls[0]?.[0]).toBe('faturamento');
    expect(mocks.scheduleJob.mock.calls[0]?.[1]).toBe('0 3 * * *');
    expect(registrado).toBe(JOB_DO_SCHEDULER);
  });

  it('anuncia o registro no boot, com nome e agendamento na linha', () => {
    registrarJob(jobFalso({ nome: 'faturamento', agendamento: '0 3 * * *' }));

    expect(linhasDe(mocks.logger.info)).toEqual([
      'Job registrado: faturamento com agendamento 0 3 * * *',
    ]);
  });

  it('não executa nada só por registrar — o disparo é do scheduler', () => {
    const job = jobFalso();

    registrarJob(job);

    expect(mocks.executarComLock).not.toHaveBeenCalled();
    expect(job.executar).not.toHaveBeenCalled();
  });
});

describe('execução disparada pelo scheduler', () => {
  it('executa o handler sob lock, usando o nome do job como chave', async () => {
    const job = jobFalso({ nome: 'cobranca' });
    const disparar = registrarECapturarDisparo(job);

    disparar();
    await aguardarCiclo();

    expect(mocks.executarComLock).toHaveBeenCalledTimes(1);
    expect(mocks.executarComLock.mock.calls[0]?.[0]).toBe('cobranca');
    expect(job.executar).toHaveBeenCalledTimes(1);
  });

  it('loga início e sucesso quando o handler conclui dentro do prazo', async () => {
    const disparar = registrarECapturarDisparo(jobFalso({ nome: 'cobranca' }));

    disparar();
    await aguardarCiclo();

    expect(linhasDe(mocks.logger.info)).toEqual([
      'Job registrado: cobranca com agendamento */5 * * * *',
      'Job iniciado: cobranca',
      expect.stringMatching(/^Job cobranca concluido em \d+ms com sucesso$/),
    ]);
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it('não chama o handler quando outra instância segura o lock', async () => {
    const job = jobFalso({ nome: 'cobranca' });
    mocks.executarComLock.mockResolvedValue({ executou: false });
    const disparar = registrarECapturarDisparo(job);

    disparar();
    await aguardarCiclo();

    expect(job.executar).not.toHaveBeenCalled();
    expect(linhasDe(mocks.logger.debug)).toEqual([
      'Lock de outra instancia pulou execucao do job cobranca',
    ]);
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it('classifica erro do handler como falha e não relança', async () => {
    const job = jobFalso({
      nome: 'cobranca',
      executar: vi.fn(async () => {
        throw new Error('fornecedor fora do ar');
      }),
    });
    const disparar = registrarECapturarDisparo(job);

    disparar();
    await aguardarCiclo();

    expect(linhasDe(mocks.logger.error)).toEqual([
      expect.stringMatching(/^Job cobranca falhou \(falha\) apos \d+ms$/),
    ]);
    expect(mocks.logger.fatal).not.toHaveBeenCalled();
  });

  it('o erro do handler vai para o log, com stack — não só a linha de desfecho', async () => {
    const erro = new Error('fornecedor fora do ar');
    const job = jobFalso({
      nome: 'cobranca',
      executar: vi.fn(async () => {
        throw erro;
      }),
    });
    const disparar = registrarECapturarDisparo(job);

    disparar();
    await aguardarCiclo();

    expect(mocks.logger.error).toHaveBeenCalledWith(
      { job: 'cobranca', status: 'falha', err: erro },
      expect.any(String),
    );
  });

  it('timeout de query do driver é falha do handler, não estouro de prazo do job', async () => {
    const job = jobFalso({
      nome: 'cobranca',
      executar: vi.fn(async () => {
        // A mensagem que o driver `mssql` (tedious) usa no timeout de query.
        throw new Error('Timeout: Request failed to complete in 15000ms');
      }),
    });
    const disparar = registrarECapturarDisparo(job);

    disparar();
    await aguardarCiclo();

    expect(linhasDe(mocks.logger.error)).toEqual([
      expect.stringMatching(/^Job cobranca falhou \(falha\) apos \d+ms$/),
    ]);
  });

  it('handler que lança de forma síncrona é classificado como falha, não como fatal', async () => {
    const job = jobFalso({
      nome: 'cobranca',
      executar: vi.fn(() => {
        throw new Error('configuração ausente');
      }),
    });
    const disparar = registrarECapturarDisparo(job);

    disparar();
    await aguardarCiclo();

    expect(linhasDe(mocks.logger.error)).toEqual([
      expect.stringMatching(/^Job cobranca falhou \(falha\) apos \d+ms$/),
    ]);
    expect(mocks.logger.fatal).not.toHaveBeenCalled();
  });

  it('um handler que falha não impede a ocorrência seguinte', async () => {
    let chamadas = 0;
    const job = jobFalso({
      executar: vi.fn(async () => {
        chamadas += 1;
        if (chamadas === 1) {
          throw new Error('falha transitória');
        }
      }),
    });
    const disparar = registrarECapturarDisparo(job);

    disparar();
    await aguardarCiclo();
    disparar();
    await aguardarCiclo();

    expect(chamadas).toBe(2);
    expect(linhasDe(mocks.logger.error)).toHaveLength(1);
    expect(linhasDe(mocks.logger.info)).toContainEqual(
      expect.stringMatching(/com sucesso$/),
    );
  });

  it('falha do próprio lock vira log fatal, não exceção no scheduler', async () => {
    const erro = new Error('pool indisponível');
    mocks.executarComLock.mockRejectedValue(erro);
    const disparar = registrarECapturarDisparo(jobFalso({ nome: 'cobranca' }));

    expect(() => disparar()).not.toThrow();
    await aguardarCiclo();

    expect(mocks.logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ job: 'cobranca', err: erro }),
      'Falha inesperada no job-runner',
    );
  });
});

describe('tempo limite do handler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    return () => {
      vi.useRealTimers();
    };
  });

  it('classifica como timeout o handler que passa de tempoLimiteMs', async () => {
    const handler = handlerControlado();
    const disparar = registrarECapturarDisparo(
      jobFalso({ nome: 'cobranca', tempoLimiteMs: 3_000, executar: handler.executar }),
    );

    disparar();
    await vi.advanceTimersByTimeAsync(3_000);
    await esvaziarMicrotarefas();

    expect(linhasDe(mocks.logger.error)).toEqual([
      expect.stringMatching(/^Job cobranca falhou \(timeout\) apos \d+ms$/),
    ]);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ job: 'cobranca', status: 'timeout' }),
      expect.any(String),
    );
  });

  /**
   * O cenário que motivou a espera: se o runner devolvesse no timeout, o
   * `executarComLock` daria commit e soltaria a trava com o handler ainda
   * rodando — e o disparo seguinte executaria o mesmo job em paralelo.
   */
  it('depois do timeout, segura o lock até o handler terminar de fato', async () => {
    const handler = handlerControlado();
    const disparar = registrarECapturarDisparo(
      jobFalso({ nome: 'cobranca', tempoLimiteMs: 3_000, executar: handler.executar }),
    );
    let lockLiberado = false;

    disparar();
    void mocks.executarComLock.mock.results.at(-1)?.value.then(() => {
      lockLiberado = true;
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await esvaziarMicrotarefas();

    expect(linhasDe(mocks.logger.error)).toHaveLength(1);
    expect(lockLiberado).toBe(false);

    handler.resolver();
    await aguardarCiclo();

    expect(lockLiberado).toBe(true);
    expect(linhasDe(mocks.logger.warn)).toEqual([
      expect.stringMatching(/^Job cobranca terminou apos o timeout, em \d+ms — lock liberado$/),
    ]);
  });

  it('handler que falha depois do timeout também solta o lock, e o erro vai para o log', async () => {
    const handler = handlerControlado();
    const erro = new Error('conexão perdida');
    const disparar = registrarECapturarDisparo(
      jobFalso({ nome: 'cobranca', tempoLimiteMs: 3_000, executar: handler.executar }),
    );

    disparar();
    await vi.advanceTimersByTimeAsync(3_000);
    handler.rejeitar(erro);
    await aguardarCiclo();

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { job: 'cobranca', err: erro },
      expect.stringMatching(/^Job cobranca falhou apos o timeout, em \d+ms — lock liberado$/),
    );
    expect(mocks.logger.fatal).not.toHaveBeenCalled();
  });

  it('ainda não desistiu um milissegundo antes do prazo', async () => {
    const job = jobFalso({
      tempoLimiteMs: 3_000,
      executar: vi.fn(() => new Promise<void>(() => { })),
    });
    const disparar = registrarECapturarDisparo(job);

    disparar();
    await vi.advanceTimersByTimeAsync(2_999);

    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it('libera o temporizador quando o handler termina antes do prazo', async () => {
    const disparar = registrarECapturarDisparo(jobFalso({ tempoLimiteMs: 3_000 }));

    disparar();
    await vi.advanceTimersByTimeAsync(0);
    await aguardarCiclo();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('libera o temporizador também quando o handler falha', async () => {
    const job = jobFalso({
      tempoLimiteMs: 3_000,
      executar: vi.fn(async () => {
        throw new Error('fornecedor fora do ar');
      }),
    });
    const disparar = registrarECapturarDisparo(job);

    disparar();
    await vi.advanceTimersByTimeAsync(0);
    await aguardarCiclo();

    expect(vi.getTimerCount()).toBe(0);
  });
});
