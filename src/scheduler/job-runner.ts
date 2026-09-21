import schedule from 'node-schedule';
import type { JobDefinition } from './job.types';
import { withJobLock } from './lock';
import { logJobStart, logJobFinish } from '../repository/execution-log.repository';
import { logger } from '../logger/logger';

async function runWithTimeout(fn: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout após ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Executa um job aplicando, nesta ordem: lock distribuído -> log de início
 * -> handler com timeout -> log de fim (sucesso/falha/timeout).
 *
 * Nenhum job individual precisa se preocupar com nada disso — só implementa
 * `handler`. Isso é o que mantém a migração dos jobs legados simples: a
 * lógica de negócio é praticamente colada, só o "entorno" muda.
 */
async function executeJob(job: JobDefinition): Promise<void> {
  const { ran } = await withJobLock(job.name, async () => {
    const executionId = await logJobStart(job.name);
    logger.info({ job: job.name, executionId }, 'Job iniciado');

    try {
      await runWithTimeout(job.handler, job.timeoutMs);
      await logJobFinish(executionId, 'success');
      logger.info({ job: job.name, executionId }, 'Job concluído com sucesso');
    } catch (err) {
      const isTimeout = err instanceof Error && err.message.startsWith('Timeout');
      const status = isTimeout ? 'timeout' : 'failure';
      const errorMessage = err instanceof Error ? err.message : String(err);

      await logJobFinish(executionId, status, errorMessage);
      logger.error({ job: job.name, executionId, err }, `Job falhou (${status})`);
    }
  });

  if (!ran) {
    logger.debug({ job: job.name }, 'Execução pulada — lock ocupado por outra instância');
  }
}

/**
 * Registra um job no scheduler do processo. Chamar uma vez por job,
 * na inicialização do serviço (ver `src/index.ts`).
 */
export function registerJob(job: JobDefinition): schedule.Job {
  logger.info({ job: job.name, cron: job.schedule }, 'Job registrado');

  return schedule.scheduleJob(job.name, job.schedule, () => {
    void executeJob(job).catch((err) => {
      // Falha aqui é bug no próprio runner, não no job — não deveria acontecer.
      logger.fatal({ job: job.name, err }, 'Falha inesperada no job-runner');
    });
  });
}
