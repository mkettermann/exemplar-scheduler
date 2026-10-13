import pino from 'pino';
import pretty from 'pino-pretty';
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

// Em desenvolvimento o pino-pretty roda como stream na thread principal, e não
// como `transport`: só assim ele escreve pelo `process.stdout`, que no console
// do Windows exibe acentos independentemente da code page.
export const logger =
  ambiente.NODE_ENV === 'development'
    ? pino(opcoesBase, pretty({ colorize: true, translateTime: 'SYS:standard', destination: process.stdout }))
    : pino(opcoesBase);
