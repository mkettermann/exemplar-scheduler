import type { DefinicaoJob } from '../scheduler/job.types.js';
import { logger } from '../logger/logger.js';
import { coletarResumoDoProcesso } from '../services/example.service.js';

/**
 * MODELO de job — apague junto com `example.service.ts` ao implementar de
 * verdade. O handler não trata lock, timeout, duração nem erro: o job-runner
 * já faz tudo isso em volta.
 *
 * Formato e passo a passo de migração em `docs/12-exemplo-job-e-servico.md`.
 */
export const jobExemplo: DefinicaoJob = {
  nome: 'example-job',
  /**
   * Só `development` de propósito: sendo um modelo, não deve disparar em
   * nenhum ambiente compartilhado. Troque pela lista real do seu job — e
   * lembre que DEV, QA e HML dividem o mesmo banco, então o mesmo job não
   * pode constar em dois deles. Ver `docs/05-scheduler.md`.
   */
  ambientes: ['development'],
  agendamento: '*/5 * * * *',
  tempoLimiteMs: 30_000,
  executar: async () => {
    const resumo = await coletarResumoDoProcesso();
    logger.info({ resumo }, 'example-job executado');
  },
};
