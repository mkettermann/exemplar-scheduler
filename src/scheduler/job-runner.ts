import schedule from 'node-schedule';
import type { DefinicaoJob, StatusJob } from './job.types.js';
import { executarComLock } from './lock.js';
import { logger } from '../logger/logger.js';

async function executarComTempoLimite(
  acao: () => Promise<void>,
  tempoLimiteMs: number,
): Promise<void> {
  let temporizador: NodeJS.Timeout;

  const expiracao = new Promise<never>((_, rejeitar) => {
    temporizador = setTimeout(
      () => rejeitar(new Error(`Timeout após ${tempoLimiteMs}ms`)),
      tempoLimiteMs,
    );
  });

  try {
    await Promise.race([acao(), expiracao]);
  } finally {
    clearTimeout(temporizador!);
  }
}

/**
 * Aplica, nesta ordem: lock distribuído, handler com timeout e log estruturado
 * do desfecho. O erro do handler é classificado e logado, nunca relançado.
 * Ver `docs/05-scheduler.md`.
 */
async function executarJob(job: DefinicaoJob): Promise<void> {
  const { executou } = await executarComLock(job.nome, async () => {
    const iniciadoEm = Date.now();
    logger.info({ job: job.nome }, 'Job iniciado');

    try {
      await executarComTempoLimite(job.executar, job.tempoLimiteMs);

      logger.info(
        { job: job.nome, status: 'sucesso' satisfies StatusJob, duracaoMs: Date.now() - iniciadoEm },
        'Job concluído com sucesso',
      );
    } catch (erro) {
      const expirou = erro instanceof Error && erro.message.startsWith('Timeout');
      const status: StatusJob = expirou ? 'timeout' : 'falha';

      logger.error(
        { job: job.nome, status, duracaoMs: Date.now() - iniciadoEm, err: erro },
        `Job falhou (${status})`,
      );
    }
  });

  if (!executou) {
    logger.debug({ job: job.nome }, 'Execução pulada — lock ocupado por outra instância');
  }
}

/**
 * Registra um job no scheduler do processo. Chamar uma vez por job, no boot.
 * Ver `docs/05-scheduler.md`.
 */
export function registrarJob(job: DefinicaoJob): schedule.Job {
  logger.info({ job: job.nome, cron: job.agendamento }, 'Job registrado');

  return schedule.scheduleJob(job.nome, job.agendamento, () => {
    void executarJob(job).catch((erro) => {
      logger.fatal({ job: job.nome, err: erro }, 'Falha inesperada no job-runner');
    });
  });
}
