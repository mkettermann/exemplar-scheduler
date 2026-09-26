import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MODELO de teste de serviço com consulta ao banco — apague junto com
 * `example-consulta.service.ts`. O `mssql.ts` é falso: o que se prova são os
 * parâmetros enviados, os defaults do filtro e o mapeamento de linha para
 * objeto. Que a query rode no SQL Server é afirmação sobre o banco, e só um
 * teste de integração a sustenta. Ver `docs/09-testes.md`.
 */
const mocks = vi.hoisted(() => ({
  obterPoolDb: vi.fn(),
  requisicao: {
    input: vi.fn(),
    query: vi.fn(),
  },
  trackTrace: vi.fn(),
}));

vi.mock('../src/db/mssql.js', () => ({
  obterPoolDb: mocks.obterPoolDb,
  fecharPoolDb: vi.fn(),
  verificarSaudeDb: vi.fn(),
  sql: { DateTime2: 'DateTime2', Int: 'Int' },
}));

vi.mock('../src/config/appInsights.js', () => ({
  appInsightsInstance: { trackTrace: mocks.trackTrace },
}));

import { listarAcionamentos } from '../src/services/example-consulta.service.js';

const AGORA = new Date('2026-09-26T12:00:00.000Z');

/** Parâmetros passados ao `.input(...)`, no formato `{ nome: [tipo, valor] }`. */
function parametrosEnviados(): Record<string, unknown[]> {
  return Object.fromEntries(
    mocks.requisicao.input.mock.calls.map(([nome, tipo, valor]) => [nome, [tipo, valor]]),
  );
}

function bancoDevolve(linhas: unknown[]): void {
  mocks.requisicao.query.mockResolvedValue({ recordset: linhas });
}

beforeEach(() => {
  vi.useFakeTimers({ now: AGORA });
  mocks.obterPoolDb.mockResolvedValue({ request: () => mocks.requisicao });
  mocks.requisicao.input.mockReturnValue(mocks.requisicao);
  bancoDevolve([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('listarAcionamentos — filtro', () => {
  it('sem filtro, busca as últimas 24 horas, limitado a 500 linhas', async () => {
    await listarAcionamentos();

    expect(parametrosEnviados()).toEqual({
      inseridosApos: ['DateTime2', new Date('2026-09-25T12:00:00.000Z')],
      limite: ['Int', 500],
    });
  });

  it('repassa o filtro recebido como parâmetro, nunca concatenado na query', async () => {
    const inseridosApos = new Date('2026-01-01T00:00:00.000Z');

    await listarAcionamentos({ inseridosApos, limite: 10 });

    expect(parametrosEnviados()).toEqual({
      inseridosApos: ['DateTime2', inseridosApos],
      limite: ['Int', 10],
    });
    expect(String(mocks.requisicao.query.mock.calls[0]?.[0])).toContain('TOP (@limite)');
  });
});

describe('listarAcionamentos — resultado', () => {
  it('monta o cliente vinculado quando o LEFT JOIN encontrou', async () => {
    const inseridoEm = new Date('2026-09-26T10:00:00.000Z');
    bancoDevolve([
      { ClienteID: 7, Notas: 'ligou', InseridoEm: inseridoEm, ClienteVinculadoID: 7, ClienteNome: 'Ana' },
    ]);

    expect(await listarAcionamentos()).toEqual([
      { clienteId: 7, notas: 'ligou', inseridoEm, cliente: { clienteId: 7, nome: 'Ana' } },
    ]);
  });

  it('cliente é null quando o LEFT JOIN não encontrou', async () => {
    const inseridoEm = new Date('2026-09-26T10:00:00.000Z');
    bancoDevolve([
      { ClienteID: 8, Notas: null, InseridoEm: inseridoEm, ClienteVinculadoID: null, ClienteNome: null },
    ]);

    expect(await listarAcionamentos()).toEqual([
      { clienteId: 8, notas: null, inseridoEm, cliente: null },
    ]);
  });
});

describe('listarAcionamentos — telemetria', () => {
  it('registra trace antes e depois da consulta, com a contagem de linhas', async () => {
    bancoDevolve([
      { ClienteID: 1, Notas: null, InseridoEm: AGORA, ClienteVinculadoID: null, ClienteNome: null },
      { ClienteID: 2, Notas: null, InseridoEm: AGORA, ClienteVinculadoID: null, ClienteNome: null },
    ]);

    await listarAcionamentos();

    expect(mocks.trackTrace.mock.calls).toEqual([
      ['listarAcionamentos: iniciando consulta'],
      ['listarAcionamentos: consulta concluída com 2 linhas'],
    ]);
  });

  it('erro do banco sobe para o job-runner, que é quem classifica e loga', async () => {
    mocks.requisicao.query.mockRejectedValue(new Error('Invalid object name'));

    await expect(listarAcionamentos()).rejects.toThrow('Invalid object name');
    expect(mocks.trackTrace).toHaveBeenCalledTimes(1);
  });
});
