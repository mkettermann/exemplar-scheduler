import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * O banco é a única dependência externa do health. Mockamos o módulo
 * inteiro para que nenhum teste precise de um MSSQL de pé — é o que
 * permite rodar "banco offline" de forma determinística.
 */
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

const BANCO_ONLINE = { ok: true, latencyMs: 4 };
const BANCO_OFFLINE = {
  ok: false,
  latencyMs: 3000,
  error: 'Timeout de 3000ms ao consultar o banco',
};

describe('GET /health (liveness)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mocks.checkDbHealth.mockResolvedValue(BANCO_ONLINE);
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('responde 200 com status ok e uptime em segundos', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    expect(res.json().uptimeSeconds).toBeTypeOf('number');
    expect(res.json().uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('é público — responde sem qualquer header de autenticação', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
  });

  it('continua 200 mesmo com o banco fora, e sequer consulta o banco', async () => {
    mocks.checkDbHealth.mockResolvedValue(BANCO_OFFLINE);

    const res = await app.inject({ method: 'GET', url: '/health' });

    // Liveness não pode depender do banco: senão o AKS reinicia o pod
    // em loop por causa de um problema que não é do processo.
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    expect(mocks.checkDbHealth).not.toHaveBeenCalled();
  });

  it('responde a HEAD, que é o que algumas probes usam', async () => {
    const res = await app.inject({ method: 'HEAD', url: '/health' });

    expect(res.statusCode).toBe(200);
  });
});

describe('GET /health/ready (readiness)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('com o banco ONLINE responde 200 e status ok', async () => {
    mocks.checkDbHealth.mockResolvedValue(BANCO_ONLINE);

    const res = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      checks: { database: { ok: true, latencyMs: 4 } },
    });
    expect(mocks.checkDbHealth).toHaveBeenCalledTimes(1);
  });

  it('com o banco OFFLINE responde 503 e status degraded', async () => {
    mocks.checkDbHealth.mockResolvedValue(BANCO_OFFLINE);

    const res = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'degraded',
      checks: { database: { ok: false } },
    });
  });

  it('fora de produção, inclui o motivo da falha para facilitar o diagnóstico', async () => {
    mocks.checkDbHealth.mockResolvedValue(BANCO_OFFLINE);

    const res = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(res.json().checks.database.error).toBe(BANCO_OFFLINE.error);
  });

  it('não derruba a rota quando o check do banco lança', async () => {
    // `checkDbHealth` é contratado para nunca lançar. Se um dia lançar,
    // queremos 500 (erro tratado) e não o processo caindo.
    mocks.checkDbHealth.mockRejectedValue(new Error('boom'));

    const res = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(res.statusCode).toBe(500);
  });

  it('acompanha a mudança de estado: online -> offline -> online', async () => {
    mocks.checkDbHealth.mockResolvedValue(BANCO_ONLINE);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);

    mocks.checkDbHealth.mockResolvedValue(BANCO_OFFLINE);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503);

    mocks.checkDbHealth.mockResolvedValue(BANCO_ONLINE);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
  });
});
