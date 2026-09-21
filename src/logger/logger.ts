import pino from 'pino';
import { env } from '../config/env';

/**
 * Em desenvolvimento: saída legível (pino-pretty).
 * Em produção: JSON puro, pronto para ser coletado pelo Log Analytics/App Insights do AKS.
 * Em teste: silencioso, para a saída do vitest não virar sopa de log.
 */
function resolveLevel(): pino.LevelWithSilent {
  if (env.NODE_ENV === 'test') return 'silent';
  return env.NODE_ENV === 'production' ? 'info' : 'debug';
}

const baseOptions: pino.LoggerOptions = {
  level: resolveLevel(),
  /**
   * Nada que passe por estas chaves é impresso em claro. Jobs que logam
   * o payload de um serviço externo não vazam segredo por descuido.
   */
  redact: {
    paths: ['password', '*.password', 'DB_PASSWORD'],
    censor: '[REDACTED]',
  },
};

export const logger =
  env.NODE_ENV === 'development'
    ? pino({
        ...baseOptions,
        transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
      })
    : pino(baseOptions);
