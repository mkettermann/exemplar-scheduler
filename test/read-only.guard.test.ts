import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  checkDbHealth: vi.fn(),
}));

vi.mock('../src/db/mssql.js', () => ({
  checkDbHealth: mocks.checkDbHealth,
  getDbPool: vi.fn(),
  closeDbPool: vi.fn(),
  sql: {},
}));

import { buildApp } from '../src/server/app.js';

/**
 * Regra da arquitetura: este serviço nunca recebe conteúdo de fora, e o
 * health é a sua única superfície HTTP. Estes testes são a trava
 * automatizada dessas duas regras.
 */
describe('serviço somente leitura', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mocks.checkDbHealth.mockResolvedValue({ ok: true, latencyMs: 1 });
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('recusa %s com 405', async (method) => {
    const res = await app.inject({ method, url: '/health', payload: { qualquer: 'coisa' } });

    expect(res.statusCode).toBe(405);
    expect(res.json()).toMatchObject({ error: 'method_not_allowed' });
  });

  it('recusa escrita também em caminho inexistente, antes do roteamento', async () => {
    const res = await app.inject({ method: 'POST', url: '/qualquer/coisa' });

    expect(res.statusCode).toBe(405);
  });

  it('GET continua funcionando normalmente', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
  });
});

describe('superfície HTTP', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mocks.checkDbHealth.mockResolvedValue({ ok: true, latencyMs: 1 });
    app = await buildApp();
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
    const res = await app.inject({ method: 'GET', url: '/admin/executions' });

    expect(res.statusCode).toBe(404);
  });
});
