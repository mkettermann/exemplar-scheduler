import schedule from 'node-schedule';
import type { Ambiente } from '../config/env.js';
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
 * Aplica, nesta ordem: lock distribuído, handler com timeout e uma linha de
 * log com o desfecho. O erro do handler é classificado e logado, nunca
 * relançado. Ver `docs/05-scheduler.md`.
 */
async function executarJob(job: DefinicaoJob): Promise<void> {
  const { executou } = await executarComLock(job.nome, async () => {
    const iniciadoEm = Date.now();
    logger.info(`Job iniciado: ${job.nome}`);

    try {
      await executarComTempoLimite(job.executar, job.tempoLimiteMs);

      logger.info(`Job ${job.nome} concluido em ${Date.now() - iniciadoEm}ms com sucesso`);
    } catch (erro) {
      const expirou = erro instanceof Error && erro.message.startsWith('Timeout');
      const status: StatusJob = expirou ? 'timeout' : 'falha';

      logger.error(`Job ${job.nome} falhou (${status}) apos ${Date.now() - iniciadoEm}ms`);
    }
  });

  if (!executou) {
    logger.debug(`Lock de outra instancia pulou execucao do job ${job.nome}`);
  }
}

/** Saída de `separarJobsPorAmbiente`. */
export interface JobsDoAmbiente {
  /** Declaram o ambiente atual — estes serão registrados. */
  ativos: DefinicaoJob[];

  /** Pertencem a outro ambiente — pulados, mas logados no boot. */
  ignorados: DefinicaoJob[];
}

/**
 * Decide quais jobs pertencem a este ambiente. É a trava que impede DEV, QA e
 * HML — que compartilham o mesmo banco — de dispararem o mesmo job sobre os
 * mesmos dados. Ver `docs/05-scheduler.md`, seção "Um job, um ambiente".
 *
 * `test` não consta em `AmbienteDeploy`, então sob o vitest nenhum job fica
 * ativo. É o comportamento correto: teste não é destino de deploy.
 */
export function separarJobsPorAmbiente(
  todos: DefinicaoJob[],
  ambienteAtual: Ambiente['NODE_ENV'],
): JobsDoAmbiente {
  const ativos: DefinicaoJob[] = [];
  const ignorados: DefinicaoJob[] = [];

  for (const job of todos) {
    if (job.ambientes.some((declarado) => declarado === ambienteAtual)) {
      ativos.push(job);
    } else {
      ignorados.push(job);
    }
  }

  return { ativos, ignorados };
}

/**
 * Registra um job no scheduler do processo. Chamar uma vez por job, no boot,
 * e só para jobs já filtrados por `separarJobsPorAmbiente`.
 * Ver `docs/05-scheduler.md`.
 */
export function registrarJob(job: DefinicaoJob): schedule.Job {
  logger.info(`Job registrado: ${job.nome} com agendamento ${job.agendamento}`);

  return schedule.scheduleJob(job.nome, job.agendamento, () => {
    void executarJob(job).catch((erro) => {
      logger.fatal({ job: job.nome, err: erro }, 'Falha inesperada no job-runner');
    });
  });
}
