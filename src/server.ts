import type { FastifyInstance } from 'fastify';
import schedule from 'node-schedule';
import { ambiente } from './config/env.js';
import { logger } from './logger/logger.js';
import { obterPoolDb, fecharPoolDb } from './db/mssql.js';
import { registrarJob } from './scheduler/job-runner.js';
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

  jobs.forEach(registrarJob);

  servidor = await construirApp();
  await servidor.listen({ port: ambiente.PORT, host: '0.0.0.0' });

  logger.info(
    `[${ambiente.NODE_ENV.toUpperCase()}] ${Util.corVerde('Scheduler no ar em')} http://0.0.0.0:${ambiente.PORT} - ${Util.corVerde('Total de jobs:')} ${jobs.length}`,
  );
}

/**
 * Encerramento ordenado: jobs em andamento, servidor HTTP e pool, nessa ordem.
 * Ver `docs/05-scheduler.md`, seção "O entrypoint: boot e encerramento".
 */
async function encerrar(sinal: string): Promise<void> {
  if (encerrando) return;
  encerrando = true;

  logger.info({ sinal }, 'Encerrando serviço...');

  try {
    await schedule.gracefulShutdown();
    await servidor?.close();
    await fecharPoolDb();
    logger.info('Serviço encerrado com sucesso');
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
