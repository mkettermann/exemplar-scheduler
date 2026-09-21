import Fastify from 'fastify';
import { env } from './config/env';
import { logger } from './logger/logger';
import { getDbPool, closeDbPool } from './db/mssql';
import { registerJob } from './scheduler/job-runner';
import { jobs } from './jobs/jobs';
import { registerRoutes } from './server/routes';
import { Util } from './util/util';

async function main(): Promise<void> {
  await getDbPool(); // falha rápido se o banco estiver inacessível

  jobs.forEach(registerJob);

  const app = Fastify({ logger: false }); // usamos nosso próprio pino, não o do fastify
  await app.register(registerRoutes);
  await app.listen({ port: env.PORT, host: '0.0.0.0' });

  const bindHost = env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';
  logger.info(`[${env.NODE_ENV.toUpperCase()}] ${Util.corVerde('Scheduler running on')} http://${bindHost}:${env.PORT} - ${Util.corVerde('Total JOBS:')} ${jobs.length}`);
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Encerrando serviço...');
  await closeDbPool();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  logger.fatal({ err }, `${Util.corVermelho('[Fatal]')} Falha ao inicializar o servidor`);
  process.exit(1);
});