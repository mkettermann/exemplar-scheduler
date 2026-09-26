import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * O `pino` é falso aqui: o que se prova é a **escolha** feita por ambiente —
 * nível, redação de segredos e o `pino-pretty` só em desenvolvimento. O
 * `NODE_ENV` é lido no import, então cada teste recarrega `logger.ts` com
 * `vi.resetModules()` e um `env.ts` falso. Ver `docs/03-logger.md`.
 */
const mocks = vi.hoisted(() => ({
  pino: vi.fn((opcoes: unknown) => ({ opcoes })),
  ambiente: { NODE_ENV: 'test' as string },
}));

vi.mock('pino', () => ({ default: mocks.pino }));

vi.mock('../src/config/env.js', () => ({ ambiente: mocks.ambiente }));

/** Opções com que o `pino` foi criado, sob o `NODE_ENV` pedido. */
async function opcoesDoLoggerEm(nodeEnv: string): Promise<Record<string, any>> {
  vi.resetModules();
  mocks.ambiente.NODE_ENV = nodeEnv;
  await import('../src/logger/logger.js');

  return mocks.pino.mock.calls.at(-1)?.[0] as Record<string, any>;
}

beforeEach(() => {
  mocks.pino.mockClear();
});

describe('logger — nível por ambiente', () => {
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

describe('logger — formato', () => {
  it('só desenvolvimento usa o pino-pretty', async () => {
    expect((await opcoesDoLoggerEm('development')).transport).toMatchObject({
      target: 'pino-pretty',
    });
  });

  it.each(['production', 'qa', 'hml', 'test'])('%s sai em JSON puro, sem transport', async (nodeEnv) => {
    expect((await opcoesDoLoggerEm(nodeEnv)).transport).toBeUndefined();
  });

  it('cria um único logger por processo', async () => {
    await opcoesDoLoggerEm('production');

    expect(mocks.pino).toHaveBeenCalledTimes(1);
  });
});

describe('logger — redação de segredos', () => {
  it('mascara a senha do banco em qualquer ambiente', async () => {
    expect((await opcoesDoLoggerEm('production')).redact).toEqual({
      paths: ['password', '*.password', 'DB_PASSWORD'],
      censor: '[REDACTED]',
    });
  });
});
