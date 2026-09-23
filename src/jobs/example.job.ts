import type { DefinicaoJob } from '../scheduler/job.types.js';
import { logger } from '../logger/logger.js';
import { coletarResumoDoProcesso } from '../services/example.service.js';

/** MODELO de job — Ver `docs/12-exemplo-job-e-servico.md`. */
export const jobExemplo: DefinicaoJob = {
  nome: 'example-job',
  ambientes: ['development'], // Ver `docs/05-scheduler.md`
  agendamento: '*/5 * * * *',
  tempoLimiteMs: 30_000,
  executar: async () => {
    const resumo = await coletarResumoDoProcesso();
    logger.info({ resumo }, 'example-job executado');
  },
};
