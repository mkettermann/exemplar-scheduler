import { obterPoolDb, sql } from '../db/mssql.js';
import { logger } from '../logger/logger.js';

/** Desfecho de uma tentativa de execução sob lock. */
export interface ResultadoComLock<T> {
  /** `false` quando outra instância já segurava a trava — a execução é pulada. */
  executou: boolean;
  resultado?: T;
}

/**
 * Trava de execução baseada em `sp_getapplock` do próprio MSSQL: garante que,
 * mesmo com dois processos vivos durante um rolling update, só um execute cada
 * job. Ver `docs/06-lock-distribuido.md`, inclusive para as limitações.
 */
export async function executarComLock<T>(
  nomeJob: string,
  acao: () => Promise<T>,
): Promise<ResultadoComLock<T>> {
  const pool = await obterPoolDb();
  const transacao = new sql.Transaction(pool);

  await transacao.begin();
  const requisicao = new sql.Request(transacao);

  try {
    const retornoLock = await requisicao
      .input('Resource', sql.NVarChar, `job:${nomeJob}`)
      .input('LockMode', sql.NVarChar, 'Exclusive')
      .input('LockOwner', sql.NVarChar, 'Transaction')
      .input('LockTimeout', sql.Int, 0)
      .query(
        `DECLARE @result int;
          EXEC @result = sp_getapplock
            @Resource = @Resource,
            @LockMode = @LockMode,
            @LockOwner = @LockOwner,
            @LockTimeout = @LockTimeout;
          SELECT @result AS result;`,
      );

    const adquiriu = (retornoLock.recordset[0]?.result ?? -1) >= 0;

    if (!adquiriu) {
      logger.warn({ job: nomeJob }, 'Job já está em execução em outra instância — pulando');
      await transacao.rollback();
      return { executou: false };
    }

    const resultado = await acao();

    await transacao.commit();
    return { executou: true, resultado };
  } catch (erro) {
    await transacao.rollback();
    throw erro;
  }
}
