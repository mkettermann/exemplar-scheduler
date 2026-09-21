import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  verificarSaudeDb: vi.fn(),
}));

vi.mock('../src/db/mssql.js', () => ({
  verificarSaudeDb: mocks.verificarSaudeDb,
  obterPoolDb: vi.fn(),
  fecharPoolDb: vi.fn(),
  sql: {},
}));

import { construirApp } from '../src/server/app.js';

/**
 * Trava automatizada de duas regras de arquitetura: o serviço nunca recebe
 * conteúdo de fora e o health é a sua única superfície HTTP.
 * Ver `docs/07-servidor-http.md` e `docs/09-testes.md`.
 */
describe('serviço somente leitura', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mocks.verificarSaudeDb.mockResolvedValue({ ok: true, latenciaMs: 1 });
    app = await construirApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('recusa %s com 405', async (metodo) => {
    const resposta = await app.inject({
      method: metodo,
      url: '/health',
      payload: { qualquer: 'coisa' },
    });

    expect(resposta.statusCode).toBe(405);
    expect(resposta.json()).toMatchObject({ error: 'method_not_allowed' });
  });

  it('recusa escrita também em caminho inexistente, antes do roteamento', async () => {
    const resposta = await app.inject({ method: 'POST', url: '/qualquer/coisa' });

    expect(resposta.statusCode).toBe(405);
  });

  it('GET continua funcionando normalmente', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/health' });

    expect(resposta.statusCode).toBe(200);
  });
});

describe('superfície HTTP', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mocks.verificarSaudeDb.mockResolvedValue({ ok: true, latenciaMs: 1 });
    app = await construirApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('expõe exatamente duas rotas, ambas de health', () => {
    expect(app.hasRoute({ method: 'GET', url: '/health' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/health/ready' })).toBe(true);
  });

  it('não expõe nenhuma rota administrativa', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/admin/executions' });

    expect(resposta.statusCode).toBe(404);
  });
});
