import { obterPoolDb, sql } from "../db/mssql.js";

export async function getParametro(ParametroGeralID: string) {
  const pool = await obterPoolDb();

  const retorno = await pool
    .request()
    .input('ParametroGeralID', sql.Int, ParametroGeralID)
    .query(`
      SELECT TOP 1
        ParametroGeralID,
        ValorParametro
      FROM ParametroGeral WITH(NOLOCK)
      WHERE ParametroGeralID = @ParametroGeralID
    `);

  return retorno.recordset.map(o => (o.ValorParametro as number))?.[0] ?? null;
}
