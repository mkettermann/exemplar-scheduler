import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * O entrypoint só liga os sinais e dispara o boot — o boot em si é testado em
 * `ciclo-de-vida.test.ts`. Aqui se prova a fiação: `SIGTERM` e `SIGINT` levam
 * ao encerramento, e falha no boot vira `fatal` e saída com código 1.
 *
 * `process.on` e `process.exit` são espionados só durante o import; os demais
 * eventos passam direto para o `process` real, que o próprio vitest usa.
 */
const mocks = vi.hoisted(() => ({
  iniciar: vi.fn(),
  encerrar: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('../src/ciclo-de-vida.js', () => ({
  iniciar: mocks.iniciar,
  encerrar: mocks.encerrar,
}));

vi.mock('../src/logger/logger.js', () => ({ logger: mocks.logger }));

const SINAIS = new Set(['SIGTERM', 'SIGINT']);
const tratadores = new Map<string, () => void>();
const saidaDoProcesso = vi.fn();

/** Executa o entrypoint do zero e espera o top-level await terminar. */
async function carregarEntrypoint(): Promise<void> {
  vi.resetModules();
  await import('../src/server.js');
}

beforeEach(() => {
  tratadores.clear();
  saidaDoProcesso.mockReset();
  mocks.iniciar.mockResolvedValue(undefined);
  mocks.encerrar.mockResolvedValue(undefined);

  const onOriginal = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((evento: string | symbol, tratador: () => void) => {
    if (typeof evento === 'string' && SINAIS.has(evento)) {
      tratadores.set(evento, tratador);
      return process;
    }
    return onOriginal(evento, tratador);
  }) as typeof process.on);
  vi.spyOn(process, 'exit').mockImplementation(saidaDoProcesso as never);
});

describe('server.ts — entrypoint', () => {
  it('dispara o boot', async () => {
    await carregarEntrypoint();

    expect(mocks.iniciar).toHaveBeenCalledTimes(1);
    expect(saidaDoProcesso).not.toHaveBeenCalled();
  });

  it.each(['SIGTERM', 'SIGINT'])('%s leva ao encerramento, com o nome do sinal', async (sinal) => {
    await carregarEntrypoint();

    tratadores.get(sinal)?.();

    expect(mocks.encerrar).toHaveBeenCalledExactlyOnceWith(sinal);
  });

  it('liga os sinais antes do boot — um SIGTERM durante o boot ainda encerra', async () => {
    mocks.iniciar.mockImplementation(async () => {
      expect([...tratadores.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
    });

    await carregarEntrypoint();

    expect(mocks.iniciar).toHaveBeenCalled();
  });

  it('falha no boot vira log fatal e saída com código 1', async () => {
    const erro = new Error('servidor inacessível');
    mocks.iniciar.mockRejectedValue(erro);

    await carregarEntrypoint();

    expect(mocks.logger.fatal).toHaveBeenCalledWith(
      { err: erro },
      expect.stringContaining('Falha ao inicializar o servidor'),
    );
    expect(saidaDoProcesso).toHaveBeenCalledExactlyOnceWith(1);
  });
});
