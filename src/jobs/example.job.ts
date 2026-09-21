import type { JobDefinition } from '../scheduler/job.types';
import { logger } from '../logger/logger';
import { coletarResumoDoProcesso } from '../services/example.service';

/**
 * MODELO de job — apague junto com `example.service.ts` ao implementar de verdade.
 *
 * Passos ao migrar um job real do CommonJS antigo:
 * 1. Crie o serviço em `src/services/` e cole a lógica de negócio lá.
 * 2. Tipe as entradas/saídas que antes não tinham tipo nenhum.
 * 3. Deixe o `handler` só orquestrando: chamar o serviço e logar o resultado.
 * 4. Ajuste `timeoutMs` para algo realista (jobs pesados precisam de um valor
 *    bem maior) e `schedule` para o cron correto.
 * 5. Rode em modo dry-run primeiro (log em vez de efeito real) antes de
 *    desativar o job correspondente no repositório legado.
 * 6. Registre o job em `src/jobs/jobs.ts`.
 *
 * O handler NÃO precisa tratar lock, log de execução, timeout ou erro —
 * o `job-runner` já faz tudo isso em volta. Ver `docs/05-scheduler.md`.
 */
export const exampleJob: JobDefinition = {
  name: 'example-job',
  schedule: '*/5 * * * *', // a cada 5 minutos — ajustar por job
  timeoutMs: 30_000,
  handler: async () => {
    const resumo = await coletarResumoDoProcesso();
    logger.info({ resumo }, 'example-job executado');
  },
};
