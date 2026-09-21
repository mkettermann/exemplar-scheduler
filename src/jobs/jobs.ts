import type { DefinicaoJob } from '../scheduler/job.types.js';
import { jobExemplo } from './example.job.js';

/**
 * Lista central de jobs ativos — a única coisa que `server.ts` importa para
 * registrar tudo. Ver `docs/05-scheduler.md`.
 */
export const jobs: DefinicaoJob[] = [
  jobExemplo,
];
