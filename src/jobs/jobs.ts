import type { JobDefinition } from '../scheduler/job.types';
import { exampleJob } from './example.job';

/**
 * Lista central de jobs ativos. Ao migrar um job do repositório legado,
 * crie o arquivo em `src/scheduler/jobs/` seguindo o modelo de
 * `example.job.ts` e adicione aqui. O `server.ts` só importa este array —
 * raramente precisa ser tocado por causa de um job novo.
 */
export const jobs: JobDefinition[] = [
	exampleJob,
];