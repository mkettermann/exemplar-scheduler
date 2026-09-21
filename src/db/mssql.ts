import sql from 'mssql';
import { env } from '../config/env';
import { logger } from '../logger/logger';

const config: sql.config = {
  server: env.DB_SERVER,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  options: {
    encrypt: env.DB_ENCRYPT,
    trustServerCertificate: env.NODE_ENV !== 'production',
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30_000,
  },
};

let pool: sql.ConnectionPool | undefined;

/**
 * Retorna o pool de conexão único do processo.
 * Nunca crie `new sql.ConnectionPool()` fora daqui — um único pool
 * compartilhado é suficiente e evita esgotar conexões no MSSQL.
 */
export async function getDbPool(): Promise<sql.ConnectionPool> {
  if (pool) {
    return pool;
  }

  pool = await new sql.ConnectionPool(config).connect();

  pool.on('error', (err: Error) => {
    logger.error({ err }, 'Erro no pool de conexão MSSQL');
  });

  logger.info('Conectado ao MSSQL');
  return pool;
}

export async function closeDbPool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = undefined;
  }
}

export { sql };
