/**
 * Contrato único que todo job implementa. É o que torna o job-runner genérico.
 * Ver `docs/05-scheduler.md`.
 */
export interface DefinicaoJob {
  /** Identificador estável: chave do lock e campo `job` de todos os logs. */
  nome: string;

  /** Expressão cron aceita pelo node-schedule. */
  agendamento: string;

  /** Tempo máximo permitido para uma execução, em milissegundos. */
  tempoLimiteMs: number;

  /** Regra de negócio do job. Deve ser idempotente sempre que possível. */
  executar: () => Promise<void>;
}

/** Desfecho de uma execução, usado no campo `status` do log estruturado. */
export type StatusJob = 'sucesso' | 'falha' | 'timeout';
