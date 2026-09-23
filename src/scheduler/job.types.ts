import type { AmbienteDeploy } from '../config/env.js';

/** Ver `docs/05-scheduler.md`. */
export interface DefinicaoJob {
  /** Identificador estável: chave do lock e campo `job` de todos os logs. */
  nome: string;

  /**
   * Ambientes onde este job roda, declarado no código e exigido pelo
   * compilador — **não existe default**. DEV, QA e HML compartilham o mesmo
   * banco: um job registrado em dois deles dispara duas vezes sobre os mesmos
   * dados, e o lock distribuído não impede isso (ele impede a execução
   * *simultânea*, não a *sequencial*). Ver `docs/05-scheduler.md`, seção
   * "Um job, um ambiente".
   */
  ambientes: AmbienteDeploy[];

  /** Expressão cron aceita pelo node-schedule. */
  agendamento: string;

  /** Tempo máximo permitido para uma execução, em milissegundos. */
  tempoLimiteMs: number;

  /**
   * Regra de negócio do job. **Precisa ser idempotente**: nem o lock nem a
   * declaração de ambiente fecham a janela de rolling update, em que dois pods
   * do mesmo ambiente podem disparar a mesma ocorrência em sequência.
   * Ver `docs/06-lock-distribuido.md`.
   */
  executar: () => Promise<void>;
}

/** Desfecho de uma execução, usado no campo `status` do log estruturado. */
export type StatusJob = 'sucesso' | 'falha' | 'timeout';
