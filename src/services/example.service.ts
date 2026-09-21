import { logger } from '../logger/logger.js';

/**
 * MODELO de serviço — apague junto com `example.job.ts` ao implementar de
 * verdade. O job diz QUANDO rodar; o serviço diz O QUE fazer, e suas fontes de
 * dados são declaradas aqui dentro, nunca recebidas por requisição.
 *
 * Ver `docs/12-exemplo-job-e-servico.md`.
 */
const LIMITE_MEMORIA_MB = 512;

export interface ResumoDoProcesso {
  uptimeSegundos: number;
  memoriaMb: number;
  acimaDoLimite: boolean;
}

export async function coletarResumoDoProcesso(): Promise<ResumoDoProcesso> {
  const memoriaMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

  const resumo: ResumoDoProcesso = {
    uptimeSegundos: Math.floor(process.uptime()),
    memoriaMb,
    acimaDoLimite: memoriaMb > LIMITE_MEMORIA_MB,
  };

  if (resumo.acimaDoLimite) {
    logger.warn({ resumo }, 'Uso de memória acima do limite configurado');
  }

  return resumo;
}
