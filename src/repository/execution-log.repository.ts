import { getDbPool, sql } from '../db/mssql';
import type { JobStatus } from '../scheduler/job.types';

/**
 * DDL de referência (rodar manualmente uma vez no banco):
 *
 * CREATE TABLE job_executions (
 *   id INT IDENTITY PRIMARY KEY,
 *   job_name NVARCHAR(200) NOT NULL,
 *   started_at DATETIME2 NOT NULL,
 *   finished_at DATETIME2 NULL,
 *   status NVARCHAR(20) NOT NULL, -- 'running' | 'success' | 'failure' | 'timeout'
 *   error_message NVARCHAR(MAX) NULL
 * );
 * CREATE INDEX ix_job_executions_job_name ON job_executions (job_name, started_at DESC);
 */

export async function logJobStart(jobName: string): Promise<number> {
  const pool = await getDbPool();
  const result = await pool
    .request()
    .input('jobName', sql.NVarChar, jobName)
    .query(
      `INSERT INTO job_executions (job_name, started_at, status)
        OUTPUT INSERTED.id
        VALUES (@jobName, SYSUTCDATETIME(), 'running')`,
    );

  return result.recordset[0].id as number;
}

export async function logJobFinish(
  executionId: number,
  status: JobStatus,
  errorMessage?: string,
): Promise<void> {
  const pool = await getDbPool();
  await pool
    .request()
    .input('id', sql.Int, executionId)
    .input('status', sql.NVarChar, status)
    .input('errorMessage', sql.NVarChar, errorMessage ?? null)
    .query(
      `UPDATE job_executions
        SET finished_at = SYSUTCDATETIME(), status = @status, error_message = @errorMessage
        WHERE id = @id`,
    );
}

export async function listRecentExecutions(limit = 50) {
  const pool = await getDbPool();
  const result = await pool
    .request()
    .input('limit', sql.Int, limit)
    .query(`SELECT TOP (@limit) * FROM job_executions ORDER BY started_at DESC`);

  return result.recordset;
}
