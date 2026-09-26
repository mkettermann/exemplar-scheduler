import { describe, expect, it, vi } from 'vitest';

/**
 * MODELO de teste de serviço — apague junto com `example.service.ts`. O
 * serviço não depende de Fastify nem de scheduler, então o teste é direto:
 * controla a entrada (aqui, o `process`) e verifica o resultado.
 * Ver `docs/09-testes.md` e `docs/12-exemplo-job-e-servico.md`.
 */
const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('../src/logger/logger.js', () => ({ logger: mocks.logger }));

import { coletarResumoDoProcesso } from '../src/services/example.service.js';

const MB = 1024 * 1024;

/** Fixa o uso de heap e o uptime que o serviço vai ler. */
function processoCom(heapUsedMb: number, uptimeSegundos: number): void {
  vi.spyOn(process, 'memoryUsage').mockReturnValue({
    rss: 0,
    heapTotal: 0,
    heapUsed: heapUsedMb * MB,
    external: 0,
    arrayBuffers: 0,
  });
  vi.spyOn(process, 'uptime').mockReturnValue(uptimeSegundos);
}

describe('coletarResumoDoProcesso', () => {
  it('resume memória em MB e uptime em segundos inteiros', async () => {
    processoCom(100.4, 61.9);

    expect(await coletarResumoDoProcesso()).toEqual({
      uptimeSegundos: 61,
      memoriaMb: 100,
      acimaDoLimite: false,
    });
  });

  it('abaixo do limite não avisa', async () => {
    processoCom(512, 10);

    const resumo = await coletarResumoDoProcesso();

    expect(resumo.acimaDoLimite).toBe(false);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('acima de 512 MB marca o resumo e avisa no log', async () => {
    processoCom(513, 10);

    const resumo = await coletarResumoDoProcesso();

    expect(resumo.acimaDoLimite).toBe(true);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { resumo },
      'Uso de memória acima do limite configurado',
    );
  });
});
