import pino from 'pino';
import { ambiente } from '../config/env.js';

/**
 * Logger estruturado único do processo.
 * Níveis por ambiente, redação de segredos e convenções de uso em
 * `docs/03-logger.md`.
 */
function definirNivel(): pino.LevelWithSilent {
  if (ambiente.NODE_ENV === 'test') return 'silent';
  return ambiente.NODE_ENV === 'production' ? 'info' : 'debug';
}

const opcoesBase: pino.LoggerOptions = {
  level: definirNivel(),
  redact: {
    paths: ['password', '*.password', 'DB_PASSWORD'],
    censor: '[REDACTED]',
  },
};

export const logger =
  ambiente.NODE_ENV === 'development'
    ? pino({
        ...opcoesBase,
        transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
      })
    : pino(opcoesBase);
