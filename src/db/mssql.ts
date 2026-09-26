import sql from 'mssql';
import { ambiente } from '../config/env.js';
import { logger } from '../logger/logger.js';

/**
 * Dono exclusivo da conexão com o MSSQL. Nenhum outro arquivo instancia
 * `sql.ConnectionPool`. Ver `docs/04-banco-de-dados.md`.
 */
const configuracao: sql.config = {
  server: ambiente.DB_SERVER,
  port: ambiente.DB_PORT,
  database: ambiente.DB_NAME,
  user: ambiente.DB_USER,
  password: ambiente.DB_PASSWORD,
  options: {
    encrypt: ambiente.DB_ENCRYPT,
    trustServerCertificate: ambiente.NODE_ENV !== 'production',
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30_000,
  },
};

let pool: sql.ConnectionPool | undefined;
let conectando: Promise<sql.ConnectionPool> | undefined;

/**
 * Pool único do processo. A promise de conexão é memoizada para que dois jobs
 * disparados durante o boot esperem a mesma conexão — ver
 * `docs/04-banco-de-dados.md`.
 */
export async function obterPoolDb(): Promise<sql.ConnectionPool> {
  if (pool) {
    return pool;
  }

  conectando ??= new sql.ConnectionPool(configuracao)
    .connect()
    .then((conectado) => {
      conectado.on('error', (erro: Error) => {
        logger.error({ err: erro }, 'Erro no pool de conexão MSSQL');
      });

      pool = conectado;
      logger.info('Conectado ao MSSQL');
      return conectado;
    })
    .finally(() => {
      conectando = undefined;
    });

  return conectando;
}

export async function fecharPoolDb(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = undefined;
  }
}

export interface SaudeBanco {
  ok: boolean;
  latenciaMs: number;
  erro?: string;
}

/**
 * Ping leve usado pelo readiness. Nunca lança: o erro vira corpo de resposta,
 * não exceção. Ver `docs/04-banco-de-dados.md`.
 */
export async function verificarSaudeDb(
  tempoLimiteMs = ambiente.HEALTH_DB_TIMEOUT_MS,
): Promise<SaudeBanco> {
  const iniciadoEm = Date.now();
  let temporizador: NodeJS.Timeout | undefined;

  try {
    const ping = obterPoolDb().then((conectado) => conectado.request().query('SELECT 1 AS ok'));

    const expiracao = new Promise<never>((_, rejeitar) => {
      temporizador = setTimeout(
        () => rejeitar(new Error(`Timeout de ${tempoLimiteMs}ms ao consultar o banco`)),
        tempoLimiteMs,
      );
    });

    await Promise.race([ping, expiracao]);
    return { ok: true, latenciaMs: Date.now() - iniciadoEm };
  } catch (error_) {
    return {
      ok: false,
      latenciaMs: Date.now() - iniciadoEm,
      erro: error_ instanceof Error ? error_.message : String(error_),
    };
  } finally {
    clearTimeout(temporizador);
  }
}

export { sql };
