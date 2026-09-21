import { getDbPool, sql } from '../db/mssql.js';
import { logger } from '../logger/logger.js';

/**
 * Trava de execução baseada em sp_getapplock do próprio MSSQL.
 *
 * Por que isso existe mesmo com réplica fixa em 1 no AKS:
 * durante um rolling update o pod antigo pode continuar vivo por
 * alguns segundos enquanto o novo já sobe — nessa janela, duas
 * instâncias do processo podem existir ao mesmo tempo. O lock
 * garante que só uma delas realmente executa o job.
 *
 * Retorna `true` se conseguiu a trava (deve executar o job) e
 * `false` se outra instância já está executando esse job agora.
 */
export async function withJobLock<T>(
  jobName: string,
  fn: () => Promise<T>,
): Promise<{ ran: boolean; result?: T }> {
  const pool = await getDbPool();
  const transaction = new sql.Transaction(pool);

  await transaction.begin();
  const request = new sql.Request(transaction);

  try {
    const lockResult = await request
      .input('Resource', sql.NVarChar, `job:${jobName}`)
      .input('LockMode', sql.NVarChar, 'Exclusive')
      .input('LockOwner', sql.NVarChar, 'Transaction')
      .input('LockTimeout', sql.Int, 0) // não espera: se estiver ocupado, desiste na hora
      .query(
        `DECLARE @result int;
          EXEC @result = sp_getapplock
            @Resource = @Resource,
            @LockMode = @LockMode,
            @LockOwner = @LockOwner,
            @LockTimeout = @LockTimeout;
          SELECT @result AS result;`,
      );

    const acquired = (lockResult.recordset[0]?.result ?? -1) >= 0;

    if (!acquired) {
      logger.warn({ jobName }, 'Job já está em execução em outra instância — pulando');
      await transaction.rollback();
      return { ran: false };
    }

    const result = await fn();

    await transaction.commit(); // libera o lock automaticamente ao fim da transação
    return { ran: true, result };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}
