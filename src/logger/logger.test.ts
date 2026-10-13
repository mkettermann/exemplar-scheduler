import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * O `pino` e o `pino-pretty` são falsos aqui: o que se prova é a **escolha**
 * feita por ambiente - nível, redação de segredos e o `pino-pretty` só em
 * desenvolvimento, escrevendo pelo `process.stdout`. O `NODE_ENV` é lido no
 * import, então cada teste recarrega `logger.ts` com `vi.resetModules()` e um
 * `env.ts` falso. Ver `docs/03-logger.md`.
 */
const mocks = vi.hoisted(() => ({
  pino: vi.fn((opcoes: unknown, destino?: unknown) => ({ opcoes, destino })),
  pinoPretty: vi.fn((opcoes: unknown) => ({ opcoesDoPretty: opcoes })),
  ambiente: { NODE_ENV: 'test' as string },
}));

vi.mock('pino', () => ({ default: mocks.pino }));

vi.mock('pino-pretty', () => ({ default: mocks.pinoPretty }));

vi.mock('../config/env.js', () => ({ ambiente: mocks.ambiente }));

/** Opções com que o `pino` foi criado, sob o `NODE_ENV` pedido. */
async function opcoesDoLoggerEm(nodeEnv: string): Promise<Record<string, any>> {
  vi.resetModules();
  mocks.ambiente.NODE_ENV = nodeEnv;
  await import('./logger.js');

  return mocks.pino.mock.calls.at(-1)?.[0] as Record<string, any>;
}

/** Destino passado ao `pino` como segundo argumento na última criação. */
function destinoDoUltimoLogger(): unknown {
  return mocks.pino.mock.calls.at(-1)?.[1];
}

beforeEach(() => {
  mocks.pino.mockClear();
  mocks.pinoPretty.mockClear();
});

describe('logger - nível por ambiente', () => {
  it.each([
    ['test', 'silent'],
    ['production', 'info'],
    ['development', 'debug'],
    ['qa', 'debug'],
    ['hml', 'debug'],
  ])('%s → %s', async (nodeEnv, nivel) => {
    expect((await opcoesDoLoggerEm(nodeEnv)).level).toBe(nivel);
  });
});

describe('logger - formato', () => {
  it('desenvolvimento usa o pino-pretty como stream do logger', async () => {
    await opcoesDoLoggerEm('development');

    expect(mocks.pinoPretty).toHaveBeenCalledTimes(1);
    expect(destinoDoUltimoLogger()).toBe(mocks.pinoPretty.mock.results[0]?.value);
  });

  it('o pino-pretty escreve pelo process.stdout, que exibe acentos no console do Windows', async () => {
    await opcoesDoLoggerEm('development');

    expect(mocks.pinoPretty).toHaveBeenCalledWith(expect.objectContaining({ destination: process.stdout }));
  });

  it('desenvolvimento não usa transport, que escreveria fora do process.stdout', async () => {
    expect((await opcoesDoLoggerEm('development')).transport).toBeUndefined();
  });

  it.each(['production', 'qa', 'hml', 'test'])('%s sai em JSON puro, sem pino-pretty', async (nodeEnv) => {
    expect((await opcoesDoLoggerEm(nodeEnv)).transport).toBeUndefined();
    expect(destinoDoUltimoLogger()).toBeUndefined();
    expect(mocks.pinoPretty).not.toHaveBeenCalled();
  });

  it('cria um único logger por processo', async () => {
    await opcoesDoLoggerEm('production');

    expect(mocks.pino).toHaveBeenCalledTimes(1);
  });
});

describe('logger - redação de segredos', () => {
  it('mascara a senha do banco em qualquer ambiente', async () => {
    expect((await opcoesDoLoggerEm('production')).redact).toEqual({
      paths: ['password', '*.password', 'DB_PASSWORD'],
      censor: '[REDACTED]',
    });
  });
});
