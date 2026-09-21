import type { JobDefinition } from '../scheduler/job.types';
import { logger } from '../logger/logger';

/**
 * MODELO para migração de jobs do repositório legado.
 *
 * Passos ao migrar um job real do CommonJS antigo:
 * 1. Copie a lógica de negócio para dentro de `handler`.
 * 2. Tipe as entradas/saídas que antes não tinham tipo nenhum.
 * 3. Ajuste `timeoutMs` para algo realista (jobs pesados 
 *    precisam de um valor bem maior).
 * 4. Rode em modo dry-run primeiro (log em vez de efeito real) antes
 *    de desativar o job correspondente no repositório legado.
 */
export const exampleJob: JobDefinition = {
  name: 'example-job',
  schedule: '*/5 * * * *', // a cada 5 minutos — ajustar por job
  timeoutMs: 30_000,
  handler: async () => {
    logger.info('Executando example-job...');
    // TODO: lógica de negócio real aqui
  },
};
