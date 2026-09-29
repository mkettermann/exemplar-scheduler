import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  verificarSaudeDb: vi.fn(),
}));

vi.mock('../../db/mssql.js', () => ({
  verificarSaudeDb: mocks.verificarSaudeDb,
  obterPoolDb: vi.fn(),
  fecharPoolDb: vi.fn(),
  sql: {},
}));

import { construirApp } from '../app.js';

/**
 * Trava automatizada de uma regra de arquitetura: o serviço nunca recebe
 * conteúdo de fora. A outra metade - o health ser a única superfície HTTP -
 * está em `routes.test.ts`. Ver `docs/07-servidor-http.md`.
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
