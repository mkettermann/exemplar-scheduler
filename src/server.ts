import type { FastifyInstance } from 'fastify';
import schedule from 'node-schedule';
import { ambiente, ambienteAssumido } from './config/env.js';
import { logger } from './logger/logger.js';
import { obterPoolDb, fecharPoolDb } from './db/mssql.js';
import { registrarJob, separarJobsPorAmbiente } from './scheduler/job-runner.js';
import { jobs } from './jobs/jobs.js';
import { construirApp } from './server/app.js';
import { Util } from './util/util.js';

let servidor: FastifyInstance | undefined;
let encerrando = false;

/**
 * Entrypoint do serviço: banco, jobs e HTTP, nessa ordem.
 * Ver `docs/05-scheduler.md`, seção "O entrypoint: boot e encerramento".
 */
async function iniciar(): Promise<void> {
  await obterPoolDb();

  if (ambienteAssumido) {
    logger.warn(
      `${Util.corAmarelo('NODE_ENV não foi injetada')} — assumindo '${ambiente.NODE_ENV}'. ` +
        'Os jobs de outros ambientes não serão registrados.',
    );
  }

  const { ativos, ignorados } = separarJobsPorAmbiente(jobs, ambiente.NODE_ENV);

  if (ambiente.JOBS_ENABLED) {
    ativos.forEach(registrarJob);
  } else {
    logger.warn(`${jobs.length} jobs, ${Util.corAmarelo('JOBS_ENABLED=false')} — nenhum job ativo`);
  }

  // Responde "por que meu job não rodou?" sem ninguém precisar abrir o código.
  for (const job of ignorados) {
    logger.info(
      `Job ${Util.corAmarelo(job.nome)} não pertence a ${Util.corAmarelo(ambiente.NODE_ENV)} — declara [${job.ambientes.join(', ')}]`,
    );
  }

  servidor = await construirApp();
  await servidor.listen({ port: ambiente.PORT, host: '0.0.0.0' });

  const jobsAtivos = ambiente.JOBS_ENABLED ? ativos.length : 0;
  const jobsAtivosNames = ambiente.JOBS_ENABLED ? ativos.map(job => job.nome).join(', ') : '';

  logger.info(`[${ambiente.NODE_ENV.toUpperCase()}] ${Util.corVerde('Scheduler no ar na porta')} ${ambiente.PORT}`);
  logger.info(`[${ambiente.NODE_ENV.toUpperCase()}] ${Util.corVerde('JOBS ativos')} ${jobsAtivos}: ${jobsAtivosNames}`);
}

/**
 * Encerramento ordenado: jobs em andamento, servidor HTTP e pool, nessa ordem.
 * Ver `docs/05-scheduler.md`, seção "O entrypoint: boot e encerramento".
 */
async function encerrar(sinal: string): Promise<void> {
  if (encerrando) return;
  encerrando = true;

  logger.info(`Encerrando sistema... ${sinal}`);

  try {
    await schedule.gracefulShutdown();
    await servidor?.close();
    await fecharPoolDb();
    logger.info('Sistema encerrado com sucesso');
    process.exit(0);
  } catch (erro) {
    logger.error({ err: erro }, 'Falha durante o encerramento');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void encerrar('SIGTERM'));
process.on('SIGINT', () => void encerrar('SIGINT'));

iniciar().catch((erro) => {
  logger.fatal({ err: erro }, `${Util.corVermelho('[Fatal]')} Falha ao inicializar o servidor`);
  process.exit(1);
});
