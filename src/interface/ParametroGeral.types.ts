
export interface ParametroGeral {
  ParametroGeralID: string; // nvarchar
  NomeParametro: string; // nvarchar
  ValorParametro: number; // decimal
  InseridoPor: number; // int
  InseridoEm: string; // datetime
  ModificadoPor: number | null; // int
  ModificadoEm: string | null; // datetime
}
