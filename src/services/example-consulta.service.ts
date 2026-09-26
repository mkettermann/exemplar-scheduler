import { appInsightsInstance } from '../config/appInsights.js';
import { obterPoolDb, sql } from '../db/mssql.js';

/**
 * MODELO de serviço com consulta ao banco — um serviço, uma consulta, três
 * peças: `QUERY`, `montar` e a exportada `listarAcionamentos`. As decisões
 * por trás do formato estão em `docs/12-exemplo-job-e-servico.md`.
 */
const JANELA_PADRAO_HORAS = 24;
const LIMITE_PADRAO_LINHAS = 500;

export interface ClienteDoAcionamento {
  clienteId: number;
  nome: string | null;
}

export interface AcionamentoComCliente {
  clienteId: number;
  notas: string | null;
  inseridoEm: Date;
  cliente: ClienteDoAcionamento | null;
}

export interface FiltroAcionamentos {
  inseridosApos?: Date;
  limite?: number;
}

interface LinhaAcionamento {
  ClienteID: number;
  Notas: string | null;
  InseridoEm: Date;
  ClienteVinculadoID: number | null;
  ClienteNome: string | null;
}

const QUERY = `
  SELECT TOP (@limite)
    a.ClienteID   AS ClienteID,
    a.Notas       AS Notas,
    a.InseridoEm  AS InseridoEm,
    c.ClienteID   AS ClienteVinculadoID,
    c.Nome        AS ClienteNome
  FROM negociacoes.Acionamento AS a WITH (NOLOCK)
  LEFT JOIN negociacoes.Clientes AS c WITH (NOLOCK)
      ON c.ClienteID = a.ClienteID
  WHERE a.InseridoEm >= @inseridosApos
  ORDER BY a.InseridoEm DESC;
`;

function montar(linha: LinhaAcionamento): AcionamentoComCliente {
  return {
    clienteId: linha.ClienteID,
    notas: linha.Notas,
    inseridoEm: linha.InseridoEm,
    cliente:
      linha.ClienteVinculadoID === null
        ? null
        : { clienteId: linha.ClienteVinculadoID, nome: linha.ClienteNome },
  };
}

export async function listarAcionamentos(
  filtro: FiltroAcionamentos = {},
): Promise<AcionamentoComCliente[]> {
  const inseridosApos =
    filtro.inseridosApos ?? new Date(Date.now() - JANELA_PADRAO_HORAS * 60 * 60 * 1000);
  const limite = filtro.limite ?? LIMITE_PADRAO_LINHAS;

  const pool = await obterPoolDb();

  appInsightsInstance.trackTrace('listarAcionamentos: iniciando consulta');

  const retorno = await pool
    .request()
    .input('inseridosApos', sql.DateTime2, inseridosApos)
    .input('limite', sql.Int, limite)
    .query<LinhaAcionamento>(QUERY);

  appInsightsInstance.trackTrace(
    `listarAcionamentos: consulta concluída com ${retorno.recordset.length} linhas`,
  );

  return retorno.recordset.map(montar);
}
