import { obterPoolDb, sql } from "../db/mssql.js";
import type { ParametroGeral } from "../interface/ParametroGeral.types.js";

export async function getParametro(ParametroGeralID: string) {
  const pool = await obterPoolDb();

  const retorno = await pool
    .request()
    .input('ParametroGeralID', sql.NVarChar, ParametroGeralID)
    .query<ParametroGeral>(`
      SELECT TOP 1
        PG.*
      FROM ParametroGeral PG WITH(NOLOCK)
      WHERE ParametroGeralID = @ParametroGeralID
    `);

  return retorno.recordset.map(o => (o.ValorParametro as number))?.[0] ?? null;
}
