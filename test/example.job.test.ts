import { describe, expect, it, vi } from 'vitest';

/**
 * MODELO de teste de job — apague junto com `example.job.ts`. O job só diz
 * QUANDO rodar e chama o serviço; o teste verifica essas duas coisas e deixa
 * lock, timeout e classificação de erro para `job-runner.test.ts`.
 * Ver `docs/12-exemplo-job-e-servico.md`.
 */
const mocks = vi.hoisted(() => ({
  coletarResumoDoProcesso: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('../src/services/example.service.js', () => ({
  coletarResumoDoProcesso: mocks.coletarResumoDoProcesso,
}));

vi.mock('../src/logger/logger.js', () => ({ logger: mocks.logger }));

import { jobExemplo } from '../src/jobs/example.job.js';
import { jobs } from '../src/jobs/jobs.js';

describe('jobExemplo', () => {
  it('só roda em desenvolvimento — um modelo não dispara em ambiente compartilhado', () => {
    expect(jobExemplo.ambientes).toEqual(['development']);
  });

  it('declara nome, agendamento e prazo', () => {
    expect(jobExemplo).toMatchObject({
      nome: 'example-job',
      agendamento: '*/5 * * * *',
      tempoLimiteMs: 30_000,
    });
  });

  it('chama o serviço e loga o resumo', async () => {
    const resumo = { uptimeSegundos: 1, memoriaMb: 50, acimaDoLimite: false };
    mocks.coletarResumoDoProcesso.mockResolvedValue(resumo);

    await jobExemplo.executar();

    expect(mocks.coletarResumoDoProcesso).toHaveBeenCalledTimes(1);
    expect(mocks.logger.info).toHaveBeenCalledWith({ resumo }, 'example-job executado');
  });

  it('não trata o erro do serviço — isso é do job-runner', async () => {
    mocks.coletarResumoDoProcesso.mockRejectedValue(new Error('falhou'));

    await expect(jobExemplo.executar()).rejects.toThrow('falhou');
  });
});

it('está registrado na lista central de jobs', () => {
  expect(jobs).toContain(jobExemplo);
});
