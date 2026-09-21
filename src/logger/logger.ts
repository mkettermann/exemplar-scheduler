import pino from 'pino';
import { env } from '../config/env';

/**
 * Em desenvolvimento: saída legível (pino-pretty).
 * Em produção: JSON puro, pronto para ser coletado pelo Log Analytics/App Insights do AKS.
 */
const baseOptions: pino.LoggerOptions = {
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
};

export const logger =
  env.NODE_ENV === 'development'
    ? pino({
        ...baseOptions,
        transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
      })
    : pino(baseOptions);
