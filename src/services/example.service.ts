import { logger } from '../logger/logger.js';

/**
 * MODELO de serviço — apague junto com `example.job.ts` ao implementar de verdade.
 *
 * Um "serviço" é onde a regra de negócio mora. O job só diz QUANDO rodar;
 * o serviço diz O QUE fazer. Essa separação é o que permite testar a regra
 * sem precisar esperar o cron disparar.
 *
 * Regra da arquitetura: as fontes de dados de um serviço são declaradas
 * AQUI DENTRO (constantes, env validado, repositórios). Nada vem de
 * requisição HTTP — o serviço nunca é chamado por alguém de fora.
 */

/** Fonte declarada no código, não recebida de fora. Veja `docs/12-exemplo-job-e-servico.md`. */
const LIMITE_MEMORIA_MB = 512;

export interface ResumoDoProcesso {
  uptimeSegundos: number;
  memoriaMb: number;
  acimaDoLimite: boolean;
}

/**
 * Coleta um resumo do próprio processo. É deliberadamente trivial e sem
 * dependência externa: o objetivo é mostrar o formato de um serviço, não
 * resolver um problema real.
 */
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
