import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * O banco é a única dependência externa do health, e o módulo inteiro é
 * mockado para que "banco offline" seja determinístico.
 * Ver `docs/09-testes.md`.
 */
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

const BANCO_ONLINE = { ok: true, latenciaMs: 4 };
const BANCO_OFFLINE = {
  ok: false,
  latenciaMs: 3000,
  erro: 'Timeout de 3000ms ao consultar o banco',
};

describe('GET /health (liveness)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mocks.verificarSaudeDb.mockResolvedValue(BANCO_ONLINE);
    app = await construirApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('responde 200 com status ok e uptime em segundos', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/health' });

    expect(resposta.statusCode).toBe(200);
    expect(resposta.json()).toMatchObject({ status: 'ok' });
    expect(resposta.json().uptimeSeconds).toBeTypeOf('number');
    expect(resposta.json().uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('é público — responde sem qualquer header de autenticação', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/health' });

    expect(resposta.statusCode).toBe(200);
  });

  it('continua 200 mesmo com o banco fora, e sequer consulta o banco', async () => {
    mocks.verificarSaudeDb.mockResolvedValue(BANCO_OFFLINE);

    const resposta = await app.inject({ method: 'GET', url: '/health' });

    expect(resposta.statusCode).toBe(200);
    expect(resposta.json().status).toBe('ok');
    expect(mocks.verificarSaudeDb).not.toHaveBeenCalled();
  });

  it('responde a HEAD, que é o que algumas probes usam', async () => {
    const resposta = await app.inject({ method: 'HEAD', url: '/health' });

    expect(resposta.statusCode).toBe(200);
  });
});

describe('GET /health/ready (readiness)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await construirApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('com o banco ONLINE responde 200 e status ok', async () => {
    mocks.verificarSaudeDb.mockResolvedValue(BANCO_ONLINE);

    const resposta = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(resposta.statusCode).toBe(200);
    expect(resposta.json()).toMatchObject({
      status: 'ok',
      checks: { database: { ok: true, latencyMs: 4 } },
    });
    expect(mocks.verificarSaudeDb).toHaveBeenCalledTimes(1);
  });

  it('com o banco OFFLINE responde 503 e status degraded', async () => {
    mocks.verificarSaudeDb.mockResolvedValue(BANCO_OFFLINE);

    const resposta = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(resposta.statusCode).toBe(503);
    expect(resposta.json()).toMatchObject({
      status: 'degraded',
      checks: { database: { ok: false } },
    });
  });

  it('fora de produção, inclui o motivo da falha para facilitar o diagnóstico', async () => {
    mocks.verificarSaudeDb.mockResolvedValue(BANCO_OFFLINE);

    const resposta = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(resposta.json().checks.database.error).toBe(BANCO_OFFLINE.erro);
  });

  it('não derruba a rota quando o check do banco lança', async () => {
    mocks.verificarSaudeDb.mockRejectedValue(new Error('boom'));

    const resposta = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(resposta.statusCode).toBe(500);
  });

  it('acompanha a mudança de estado: online -> offline -> online', async () => {
    mocks.verificarSaudeDb.mockResolvedValue(BANCO_ONLINE);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);

    mocks.verificarSaudeDb.mockResolvedValue(BANCO_OFFLINE);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503);

    mocks.verificarSaudeDb.mockResolvedValue(BANCO_ONLINE);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
  });
});
