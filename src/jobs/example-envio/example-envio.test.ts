import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MODELO de teste de serviço com POST autenticado - apague junto com
 * `example-envio.service.ts`. O `fetch` é falso: o que se prova é a ordem das
 * chamadas, o token da autenticacao chegando no header `token-id` e a recusa
 * de resposta fora do contrato. Que o parceiro aceite o envio é afirmação
 * sobre ele, e só um teste de integração a sustenta. Ver `docs/09-testes.md`.
 */
const mocks = vi.hoisted(() => ({
  ambiente: { EXAMPLE_ENVIO_API_KEY: 'chave-teste' as string | undefined },
  fetch: vi.fn(),
  trackTrace: vi.fn(),
}));

vi.mock('../../config/env.js', () => ({ ambiente: mocks.ambiente }));

vi.mock('../../config/appInsights.js', () => ({
  appInsightsInstance: { trackTrace: mocks.trackTrace },
}));

import { enviarRegistro } from './example-envio.service.js';

const URL_AUTENTICACAO = 'https://auth.parceiro.example/api/v1/token';
const URL_ENVIO = 'https://api.parceiro.example/api/v1/registros';
const REGISTRO = { clienteId: 7, mensagem: 'acordo fechado' };

function resposta(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status });
}

/** Cada chamada ao `fetch`, no formato `{ url, method, headers, body }`. */
function chamadas() {
  return (mocks.fetch.mock.calls as [string, RequestInit][]).map(([url, init]) => ({
    url,
    method: init.method,
    headers: init.headers,
    body: JSON.parse(String(init.body)),
  }));
}

/** Respostas em ordem: a primeira é da autenticacao, a segunda do envio. */
function parceiroResponde(...respostas: Response[]): void {
  for (const r of respostas) {
    mocks.fetch.mockResolvedValueOnce(r);
  }
}

beforeEach(() => {
  mocks.ambiente.EXAMPLE_ENVIO_API_KEY = 'chave-teste';
  vi.stubGlobal('fetch', mocks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('enviarRegistro - chamadas', () => {
  it('autentica com a apiKey e envia o registro com o token no header `token-id`', async () => {
    parceiroResponde(resposta({ token: 'tok-1' }), resposta({ protocolo: 'P-1' }));

    await enviarRegistro(REGISTRO);

    expect(chamadas()).toEqual([
      {
        url: URL_AUTENTICACAO,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { apiKey: 'chave-teste' },
      },
      {
        url: URL_ENVIO,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'token-id': 'tok-1' },
        body: REGISTRO,
      },
    ]);
  });

  it('autentica de novo a cada envio - o token é temporário e não é guardado', async () => {
    parceiroResponde(
      resposta({ token: 'tok-1' }),
      resposta({ protocolo: 'P-1' }),
      resposta({ token: 'tok-2' }),
      resposta({ protocolo: 'P-2' }),
    );

    await enviarRegistro(REGISTRO);
    await enviarRegistro(REGISTRO);

    expect(chamadas().map((c) => c.url)).toEqual([
      URL_AUTENTICACAO,
      URL_ENVIO,
      URL_AUTENTICACAO,
      URL_ENVIO,
    ]);
    expect(chamadas()[3]?.headers).toMatchObject({ 'token-id': 'tok-2' });
  });

  it('toda chamada leva um AbortSignal - sem ele, o timeout do runner não interrompe nada', async () => {
    parceiroResponde(resposta({ token: 'tok-1' }), resposta({ protocolo: 'P-1' }));

    await enviarRegistro(REGISTRO);

    for (const [, init] of mocks.fetch.mock.calls as [string, RequestInit][]) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('devolve o protocolo validado do parceiro', async () => {
    parceiroResponde(resposta({ token: 'tok-1' }), resposta({ protocolo: 'P-1', extra: true }));

    expect(await enviarRegistro(REGISTRO)).toEqual({ protocolo: 'P-1' });
  });
});

describe('enviarRegistro - falhas', () => {
  it('sem apiKey no ambiente, falha antes de qualquer chamada de rede', async () => {
    mocks.ambiente.EXAMPLE_ENVIO_API_KEY = undefined;

    await expect(enviarRegistro(REGISTRO)).rejects.toThrow('EXAMPLE_ENVIO_API_KEY ausente');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('autenticacao recusada não envia, e o erro não carrega a apiKey', async () => {
    parceiroResponde(resposta({ erro: 'apiKey inválida' }, 401));

    const erro = await enviarRegistro(REGISTRO).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(Error);
    expect((erro as Error).message).toBe('Autenticacao respondeu 401');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('autenticacao sem token no corpo não envia', async () => {
    parceiroResponde(resposta({ access: 'tok-1' }));

    await expect(enviarRegistro(REGISTRO)).rejects.toThrow();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('envio recusado sobe para o job-runner com o status', async () => {
    parceiroResponde(resposta({ token: 'tok-1' }), resposta({}, 500));

    await expect(enviarRegistro(REGISTRO)).rejects.toThrow('Envio respondeu 500');
  });

  it('envio aceito sem protocolo é falha, não sucesso silencioso', async () => {
    parceiroResponde(resposta({ token: 'tok-1' }), resposta({ ok: true }));

    await expect(enviarRegistro(REGISTRO)).rejects.toThrow();
  });
});

describe('enviarRegistro - telemetria', () => {
  it('registra trace em cada etapa, sem token nem apiKey', async () => {
    parceiroResponde(resposta({ token: 'tok-1' }), resposta({ protocolo: 'P-1' }));

    await enviarRegistro(REGISTRO);

    expect(mocks.trackTrace.mock.calls).toEqual([
      ['enviarRegistro: autenticando'],
      ['enviarRegistro: enviando'],
      ['enviarRegistro: concluído com protocolo P-1'],
    ]);
  });
});
