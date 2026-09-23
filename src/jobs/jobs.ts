import type { DefinicaoJob } from '../scheduler/job.types.js';
import { jobExemplo } from './example.job.js';

/** Ver `docs/05-scheduler.md`. */
export const jobs: DefinicaoJob[] = [
  jobExemplo,
];
