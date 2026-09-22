import schedule from 'node-schedule';
import type { DefinicaoJob, StatusJob } from './job.types.js';
import { executarComLock } from './lock.js';
import { logger } from '../logger/logger.js';
import { Util } from '../util/util.js';

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
    logger.info(`Job iniciado: ${Util.corAmarelo(job.nome)}`);

    try {
      await executarComTempoLimite(job.executar, job.tempoLimiteMs);

      logger.info(`Job concluido em ${Util.corAmarelo((Date.now() - iniciadoEm).toString() + 'ms')} com sucesso`);
    } catch (erro) {
      const expirou = erro instanceof Error && erro.message.startsWith('Timeout');
      const status: StatusJob = expirou ? 'timeout' : 'falha';

      logger.error(`Job ${Util.corAmarelo(job.nome)} falhou (${status}) apos ${Util.corAmarelo((Date.now() - iniciadoEm).toString() + 'ms')}`);
    }
  });

  if (!executou) {
    logger.debug(`Lock de outra instancia pulou execucao do job ${Util.corAmarelo(job.nome)}`);
  }
}

/**
 * Registra um job no scheduler do processo. Chamar uma vez por job, no boot.
 * Ver `docs/05-scheduler.md`.
 */
export function registrarJob(job: DefinicaoJob): schedule.Job {
  logger.info(`Job registrado: ${Util.corAmarelo(job.nome)} com agendamento ${Util.corAmarelo(job.agendamento)}`);

  return schedule.scheduleJob(job.nome, job.agendamento, () => {
    void executarJob(job).catch((erro) => {
      logger.fatal({ job: job.nome, err: erro }, 'Falha inesperada no job-runner');
    });
  });
}
