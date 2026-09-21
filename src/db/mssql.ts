import sql from 'mssql';
import { env } from '../config/env.js';
import { logger } from '../logger/logger.js';

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
let connecting: Promise<sql.ConnectionPool> | undefined;

/**
 * Retorna o pool de conexão único do processo.
 * Nunca crie `new sql.ConnectionPool()` fora daqui — um único pool
 * compartilhado é suficiente e evita esgotar conexões no MSSQL.
 *
 * A promise de conexão é memoizada: se dois jobs dispararem no mesmo
 * segundo durante o boot, os dois esperam a MESMA conexão em vez de
 * abrirem dois pools concorrentes.
 */
export async function getDbPool(): Promise<sql.ConnectionPool> {
  if (pool) {
    return pool;
  }

  if (!connecting) {
    connecting = new sql.ConnectionPool(config)
      .connect()
      .then((connected) => {
        connected.on('error', (err: Error) => {
          logger.error({ err }, 'Erro no pool de conexão MSSQL');
        });

        pool = connected;
        logger.info('Conectado ao MSSQL');
        return connected;
      })
      .finally(() => {
        // Libera a memoização para que uma falha possa ser tentada de novo.
        connecting = undefined;
      });
  }

  return connecting;
}

export async function closeDbPool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = undefined;
  }
}

export interface DbHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * Ping leve usado pelo readiness (`GET /health/ready`).
 *
 * Nunca lança: o endpoint de saúde precisa responder mesmo — aliás,
 * principalmente — quando o banco está fora. O erro vira parte do corpo
 * da resposta, não uma exceção que derruba a rota.
 */
export async function checkDbHealth(timeoutMs = env.HEALTH_DB_TIMEOUT_MS): Promise<DbHealth> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;

  try {
    const ping = getDbPool().then((connected) => connected.request().query('SELECT 1 AS ok'));

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout de ${timeoutMs}ms ao consultar o banco`)), timeoutMs);
    });

    await Promise.race([ping, timeout]);
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export { sql };
