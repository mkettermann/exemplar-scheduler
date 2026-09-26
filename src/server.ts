// Primeiro: é ele que carrega o Application Insights antes do Fastify — ver docs/13.
import { iniciar, encerrar } from './ciclo-de-vida.js';
import { logger } from './logger/logger.js';
import { Util } from './util/util.js';

/**
 * Entrypoint do serviço: só liga os sinais e dispara o boot. O que acontece
 * em cada fase está em `ciclo-de-vida.ts`.
 * Ver `docs/05-scheduler.md`, seção "O entrypoint: boot e encerramento".
 */
process.on('SIGTERM', () => void encerrar('SIGTERM'));
process.on('SIGINT', () => void encerrar('SIGINT'));

try {
  await iniciar();
} catch (error_) {
  logger.fatal({ err: error_ }, `${Util.corVermelho('[Fatal]')} Falha ao inicializar o servidor`);
  process.exit(1);
}
