import schedule from 'node-schedule';
import type { Ambiente } from '../config/env.js';
import type { DefinicaoJob, StatusJob } from './job.types.js';
import { executarComLock } from './lock.js';
import { logger } from '../logger/logger.js';

/**
 * Estouro de `tempoLimiteMs`. Classe própria porque a classificação não pode
 * depender da mensagem: o timeout de query do driver `mssql` também começa com
 * "Timeout", e é uma `falha` do handler, não um estouro de prazo do job.
 */
class ErroTempoLimite extends Error {
  constructor(tempoLimiteMs: number) {
    super(`Timeout após ${tempoLimiteMs}ms`);
    this.name = 'ErroTempoLimite';
  }
}

async function aguardarComTempoLimite(
  execucao: Promise<void>,
  tempoLimiteMs: number,
): Promise<void> {
  let temporizador: NodeJS.Timeout | undefined;

  const expiracao = new Promise<never>((_, rejeitar) => {
    temporizador = setTimeout(() => rejeitar(new ErroTempoLimite(tempoLimiteMs)), tempoLimiteMs);
  });

  try {
    await Promise.race([execucao, expiracao]);
  } finally {
    clearTimeout(temporizador);
  }
}

/** `async` converte um `throw` síncrono do handler em rejeição, classificada como as demais. */
async function dispararHandler(job: DefinicaoJob): Promise<void> {
  await job.executar();
}

/**
 * O timeout para a espera, não o handler. Devolver agora faria o
 * `executarComLock` dar commit e soltar a trava com o handler ainda rodando —
 * e o disparo seguinte, ou o de outra réplica, executaria o mesmo job em
 * paralelo. Então a trava fica presa até o handler terminar de fato.
 * Ver `docs/05-scheduler.md`.
 */
async function aguardarFimAposTimeout(
  job: DefinicaoJob,
  execucao: Promise<void>,
  iniciadoEm: number,
): Promise<void> {
  try {
    await execucao;
    logger.warn(
      { job: job.nome },
      `Job ${job.nome} terminou apos o timeout, em ${Date.now() - iniciadoEm}ms — lock liberado`,
    );
  } catch (error_) {
    logger.warn(
      { job: job.nome, err: error_ },
      `Job ${job.nome} falhou apos o timeout, em ${Date.now() - iniciadoEm}ms — lock liberado`,
    );
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

    const execucao = dispararHandler(job);

    try {
      await aguardarComTempoLimite(execucao, job.tempoLimiteMs);

      logger.info(`Job ${job.nome} concluido em ${Date.now() - iniciadoEm}ms com sucesso`);
    } catch (error_) {
      const status: StatusJob = error_ instanceof ErroTempoLimite ? 'timeout' : 'falha';

      logger.error(
        { job: job.nome, status, err: error_ },
        `Job ${job.nome} falhou (${status}) apos ${Date.now() - iniciadoEm}ms`,
      );

      if (status === 'timeout') {
        await aguardarFimAposTimeout(job, execucao, iniciadoEm);
      }
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
    // Alarga o tipo só para o `includes`: `ambienteAtual` pode ser `test`, que não é `AmbienteDeploy`.
    if ((job.ambientes as readonly Ambiente['NODE_ENV'][]).includes(ambienteAtual)) {
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
    void executarJob(job).catch((error_) => {
      logger.fatal({ job: job.nome, err: error_ }, 'Falha inesperada no job-runner');
    });
  });
}
