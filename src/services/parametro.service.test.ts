import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * O `mssql.ts` é falso: o que se prova é o parâmetro enviado e a leitura do
 * `recordset`. Ver `docs/09-testes.md`.
 */
const mocks = vi.hoisted(() => ({
  obterPoolDb: vi.fn(),
  requisicao: {
    input: vi.fn(),
    query: vi.fn(),
  },
}));

vi.mock('../db/mssql.js', () => ({
  obterPoolDb: mocks.obterPoolDb,
  fecharPoolDb: vi.fn(),
  verificarSaudeDb: vi.fn(),
  sql: { Int: 'Int', NVarChar: 'NVarChar' },
}));

import { getParametro } from './parametro.service.js';

function bancoDevolve(linhas: unknown[]): void {
  mocks.requisicao.query.mockResolvedValue({ recordset: linhas });
}

beforeEach(() => {
  mocks.obterPoolDb.mockResolvedValue({ request: () => mocks.requisicao });
  mocks.requisicao.input.mockReturnValue(mocks.requisicao);
  bancoDevolve([]);
});

describe('getParametro', () => {
  it('envia o ID como NVarChar - a chave da ParametroGeral é texto', async () => {
    await getParametro('LOG_EXEMPLO');

    expect(mocks.requisicao.input).toHaveBeenCalledWith('ParametroGeralID', 'NVarChar', 'LOG_EXEMPLO');
    expect(String(mocks.requisicao.query.mock.calls[0]?.[0])).toContain('@ParametroGeralID');
  });

  it('devolve o ValorParametro da linha encontrada', async () => {
    bancoDevolve([{ ParametroGeralID: 'LOG_EXEMPLO', ValorParametro: 2.5 }]);

    expect(await getParametro('LOG_EXEMPLO')).toBe(2.5);
  });

  it('devolve null quando o parâmetro não existe', async () => {
    expect(await getParametro('NAO_EXISTE')).toBeNull();
  });
});
