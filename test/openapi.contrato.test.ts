import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { parse } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';

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
import { registrarRotas } from '../src/server/routes.js';

interface Operacao {
  responses: Record<string, { content?: { 'application/json'?: { schema: object } } }>;
}

interface Especificacao {
  paths: Record<string, Record<string, Operacao>>;
  components: { schemas: Record<string, object> };
}

const especificacao = parse(
  readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'),
) as Especificacao;

/** "GET /health", "GET /health/ready"... — o mesmo formato dos dois lados. */
function operacoesDoSpec(): string[] {
  return Object.entries(especificacao.paths)
    .flatMap(([caminho, metodos]) =>
      Object.keys(metodos).map((metodo) => `${metodo.toUpperCase()} ${caminho}`),
    )
    .sort();
}

/**
 * Registra o mapa de rotas numa instância limpa só para ouvir o `onRoute`.
 * `HEAD` fica de fora: o Fastify o cria sozinho para cada `GET`.
 */
async function operacoesRegistradas(): Promise<string[]> {
  const app = Fastify();
  const encontradas: string[] = [];

  app.addHook('onRoute', ({ method, url }) => {
    for (const metodo of [method].flat()) {
      if (metodo !== 'HEAD') encontradas.push(`${metodo} ${url}`);
    }
  });

  await app.register(registrarRotas);
  await app.ready();
  await app.close();

  return encontradas.sort();
}

/**
 * Valida o corpo contra o schema documentado para aquele caminho e status.
 * Os schemas do spec usam `additionalProperties: false`, então campo novo que
 * não foi documentado também reprova.
 */
function validarContraSpec(caminho: string, status: number, corpo: unknown): void {
  const schema =
    especificacao.paths[caminho]?.get?.responses[String(status)]?.content?.['application/json']
      ?.schema;

  expect(schema, `${caminho} não documenta a resposta ${status}`).toBeDefined();

  const ajv = new Ajv2020({ strict: false });
  ajv.addSchema({ $id: 'openapi', components: especificacao.components });

  const validar = ajv.compile({
    ...schema,
    $ref: String((schema as { $ref: string }).$ref).replace(/^#/, 'openapi#'),
  });

  expect(validar(corpo), JSON.stringify(validar.errors, null, 2)).toBe(true);
}

/**
 * Trava a documentação OpenAPI à superfície HTTP real: rota nova sem
 * documentação, rota documentada que sumiu e corpo de resposta que divergiu
 * do schema falham aqui. Ver `docs/07-servidor-http.md`.
 */
describe('openapi.yaml', () => {
  it('documenta exatamente as rotas registradas em routes.ts', async () => {
    expect(operacoesDoSpec()).toEqual(await operacoesRegistradas());
  });

  describe('respostas reais batem com os schemas documentados', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = await construirApp();
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it('GET /health → 200', async () => {
      const resposta = await app.inject({ method: 'GET', url: '/health' });

      expect(resposta.statusCode).toBe(200);
      validarContraSpec('/health', 200, resposta.json());
    });

    it('GET /health/ready → 200 com o banco online', async () => {
      mocks.verificarSaudeDb.mockResolvedValue({ ok: true, latenciaMs: 4 });

      const resposta = await app.inject({ method: 'GET', url: '/health/ready' });

      expect(resposta.statusCode).toBe(200);
      validarContraSpec('/health/ready', 200, resposta.json());
    });

    it('GET /health/ready → 503 com o banco offline, incluindo o campo error', async () => {
      mocks.verificarSaudeDb.mockResolvedValue({
        ok: false,
        latenciaMs: 3000,
        erro: 'Timeout de 3000ms ao consultar o banco',
      });

      const resposta = await app.inject({ method: 'GET', url: '/health/ready' });

      expect(resposta.statusCode).toBe(503);
      validarContraSpec('/health/ready', 503, resposta.json());
    });
  });
});
