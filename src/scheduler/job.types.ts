/**
 * Contrato único que todo job — novo ou migrado do repositório legado —
 * deve implementar. Isso é o que torna o `job-runner` genérico: ele não
 * sabe nada sobre a regra de negócio de cada job, só sabe rodar este contrato.
 */
export interface JobDefinition {
  /** Identificador único e estável do job (usado no lock e nos logs de execução). */
  name: string;

  /**
   * Expressão cron aceita pelo node-schedule (ex.: a cada 6 horas).
   * Mantenha cron string sempre que possível — é o formato que o
   * time já conhece do repositório legado.
   */
  schedule: string;

  /** Tempo máximo permitido para uma execução, em milissegundos. */
  timeoutMs: number;

  /** Lógica de negócio do job. Deve ser idempotente sempre que possível. */
  handler: () => Promise<void>;
}

export type JobStatus = 'success' | 'failure' | 'timeout';

export interface JobExecutionRecord {
  jobName: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: JobStatus | 'running';
  errorMessage: string | null;
}
