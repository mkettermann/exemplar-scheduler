import type { FastifyInstance } from 'fastify';
import schedule from 'node-schedule';
import { env } from './config/env';
import { logger } from './logger/logger';
import { getDbPool, closeDbPool } from './db/mssql';
import { registerJob } from './scheduler/job-runner';
import { jobs } from './jobs/jobs';
import { buildApp } from './server/app';
import { Util } from './util/util';

let app: FastifyInstance | undefined;
let encerrando = false;

async function main(): Promise<void> {
  await getDbPool(); // falha rápido se o banco estiver inacessível

  jobs.forEach(registerJob);

  app = await buildApp();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });

  logger.info(
    `[${env.NODE_ENV.toUpperCase()}] ${Util.corVerde('Scheduler running on')} http://0.0.0.0:${env.PORT} - ${Util.corVerde('Total JOBS:')} ${jobs.length}`,
  );
}

/**
 * Desligamento ordenado, na ordem que importa durante um rolling update do AKS:
 *
 * 1. `gracefulShutdown` do node-schedule — para de agendar novas execuções e
 *    ESPERA as que já estão rodando terminarem (um job cortado na metade é
 *    exatamente o que o lock distribuído não consegue desfazer).
 * 2. Fecha o servidor HTTP — para de aceitar novas requisições.
 * 3. Fecha o pool do banco — só depois que ninguém mais precisa dele.
 */
async function shutdown(signal: string): Promise<void> {
  if (encerrando) return;
  encerrando = true;

  logger.info({ signal }, 'Encerrando serviço...');

  try {
    await schedule.gracefulShutdown();
    await app?.close();
    await closeDbPool();
    logger.info('Serviço encerrado com sucesso');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Falha durante o encerramento');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  logger.fatal({ err }, `${Util.corVermelho('[Fatal]')} Falha ao inicializar o servidor`);
  process.exit(1);
});
