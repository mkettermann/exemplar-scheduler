import schedule from 'node-schedule';
import type { JobDefinition, JobStatus } from './job.types';
import { withJobLock } from './lock';
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
 * Executa um job aplicando, nesta ordem: lock distribuído -> handler com
 * timeout -> log estruturado do desfecho (sucesso/falha/timeout) e da duração.
 *
 * Nenhum job individual precisa se preocupar com nada disso — só implementa
 * `handler`. Isso é o que mantém a migração dos jobs legados simples: a
 * lógica de negócio é praticamente colada, só o "entorno" muda.
 */
async function executeJob(job: JobDefinition): Promise<void> {
  const { ran } = await withJobLock(job.name, async () => {
    const iniciadoEm = Date.now();
    logger.info({ job: job.name }, 'Job iniciado');

    try {
      await runWithTimeout(job.handler, job.timeoutMs);

      logger.info(
        { job: job.name, status: 'success' satisfies JobStatus, durationMs: Date.now() - iniciadoEm },
        'Job concluído com sucesso',
      );
    } catch (err) {
      const isTimeout = err instanceof Error && err.message.startsWith('Timeout');
      const status: JobStatus = isTimeout ? 'timeout' : 'failure';

      // O erro não é relançado: um job que falha não derruba o processo
      // nem impede a próxima execução agendada.
      logger.error(
        { job: job.name, status, durationMs: Date.now() - iniciadoEm, err },
        `Job falhou (${status})`,
      );
    }
  });

  if (!ran) {
    logger.debug({ job: job.name }, 'Execução pulada — lock ocupado por outra instância');
  }
}

/**
 * Registra um job no scheduler do processo. Chamar uma vez por job,
 * na inicialização do serviço (ver `src/server.ts`).
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
