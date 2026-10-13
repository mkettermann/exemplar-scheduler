import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * O `fetch` e o logger são falsos: o que se prova é o que a classe `Rest`
 * monta para a rede (verbo, headers, corpo) e como ela traduz a resposta -
 * sucesso, status de erro, falha de conexão - no formato `RestResposta`, além
 * da validação de contrato do `Rest.Validar`. Cada função exportada tem
 * o seu `describe`. Ver `docs/14-cliente-rest.md`.
 */
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock('../../logger/logger.js', () => ({
  logger: { error: mocks.loggerError, debug: mocks.loggerDebug },
}));

import { getFetchOptions, getFetchResponse, Rest, validarRetornoZod } from './fetch_uteis.js';

const URL_API = 'https://api.parceiro.example/v1/registros';
const ESQUEMA = z.object({ protocolo: z.string() });

function resposta(corpo: unknown, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** O servidor falso responde, em ordem, cada resposta dada. */
function servidorResponde(...respostas: Response[]): void {
  for (const r of respostas) {
    mocks.fetch.mockResolvedValueOnce(r);
  }
}

/** Cada chamada ao `fetch`, no formato `{ url, method, headers, body }`. */
function chamadas() {
  return (mocks.fetch.mock.calls as [string, RequestInit][]).map(([url, init]) => ({
    url,
    method: init.method,
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    body: init.body,
  }));
}

function headersDe(opcoes: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(opcoes.headers).entries());
}

beforeEach(() => {
  vi.stubGlobal('fetch', mocks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.fetch.mockReset();
  mocks.loggerError.mockReset();
  mocks.loggerDebug.mockReset();
});

describe('getFetchOptions', () => {
  it('padrão é GET com Content-Type JSON e sem body', () => {
    const opcoes = getFetchOptions({ a: 1 });

    expect(opcoes.method).toBe('GET');
    expect(opcoes.body).toBeUndefined();
    expect(headersDe(opcoes)).toEqual({ 'content-type': 'application/json' });
  });

  it.each(['POST', 'PUT', 'PATCH'])('%s serializa o payload em JSON no body', (metodo) => {
    expect(getFetchOptions({ a: 1 }, { method: metodo }).body).toBe('{"a":1}');
  });

  it.each(['GET', 'HEAD', 'DELETE', 'OPTIONS'])('%s nunca envia body, nem o de `options`', (metodo) => {
    expect(getFetchOptions({ a: 1 }, { method: metodo, body: 'x' }).body).toBeUndefined();
  });

  it('normaliza o verbo para maiúsculas antes de decidir o body', () => {
    const opcoes = getFetchOptions({ a: 1 }, { method: 'get' });

    expect(opcoes.method).toBe('GET');
    expect(opcoes.body).toBeUndefined();
  });

  it('acrescenta os headers extras aos padrões', () => {
    const opcoes = getFetchOptions(null, undefined, { Authorization: 'Bearer tok' });

    expect(headersDe(opcoes)).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer tok',
    });
  });

  it('header do chamador substitui o padrão em vez de ser anexado', () => {
    const opcoes = getFetchOptions(null, undefined, { 'Content-Type': 'text/plain' });

    expect(headersDe(opcoes)).toEqual({ 'content-type': 'text/plain' });
  });

  it('`options.headers` soma aos padrões, e `headers` vence os dois', () => {
    const opcoes = getFetchOptions(
      null,
      { headers: { 'x-a': '1', authorization: 'antigo' } },
      { Authorization: 'novo' },
    );

    expect(headersDe(opcoes)).toEqual({
      'content-type': 'application/json',
      'x-a': '1',
      authorization: 'novo',
    });
  });

  it('repassa as demais opções, como o `signal`', () => {
    const signal = AbortSignal.timeout(1000);

    expect(getFetchOptions(null, { signal }).signal).toBe(signal);
  });
});

describe('getFetchResponse', () => {
  it('lê o corpo JSON', async () => {
    expect(await getFetchResponse(resposta([1, 2]))).toEqual([1, 2]);
  });

  it('texto que não é JSON volta como string', async () => {
    const r = new Response('aceito', { headers: { 'Content-Type': 'text/plain' } });

    expect(await getFetchResponse(r)).toBe('aceito');
  });

  it('JSON sem Content-Type ainda é interpretado - compatível com o legado', async () => {
    expect(await getFetchResponse(new Response('{"a":1}'))).toEqual({ a: 1 });
  });

  it('corpo vazio vira null', async () => {
    expect(await getFetchResponse(new Response(null, { status: 204 }))).toBeNull();
  });

  it('conteúdo binário volta como Blob', async () => {
    const r = new Response(new Uint8Array([37, 80, 68, 70]), {
      headers: { 'Content-Type': 'application/pdf' },
    });

    const corpo = await getFetchResponse(r);

    expect(corpo).toBeInstanceOf(Blob);
    expect((corpo as Blob).size).toBe(4);
  });

  it('corpo já consumido vira null em vez de lançar', async () => {
    const r = resposta({ a: 1 });
    await r.text();

    expect(await getFetchResponse(r)).toBeNull();
  });
});

describe('validarRetornoZod', () => {
  it('aprova objeto no formato', () => {
    expect(validarRetornoZod(ESQUEMA, { protocolo: 'P-1' })).toBe(true);
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('aceita schema que não é objeto, como uma lista', () => {
    expect(validarRetornoZod(z.array(ESQUEMA), [{ protocolo: 'P-1' }])).toBe(true);
  });

  it('reprova fora do formato e loga só as issues, nunca o objeto', () => {
    expect(validarRetornoZod(ESQUEMA, { protocolo: 1, token: 'segredo' })).toBe(false);

    expect(mocks.loggerError).toHaveBeenCalledWith(
      { issues: [expect.objectContaining({ path: ['protocolo'] })] },
      'Rest: resposta fora do contrato',
    );
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain('segredo');
  });

  it.each<[string, unknown]>([
    ['objeto comum', {}],
    ['null', null],
  ])('reprova validador que não é schema zod: %s', (_rotulo, validador) => {
    expect(validarRetornoZod(validador as z.ZodTypeAny, { protocolo: 'P-1' })).toBe(false);
    expect(mocks.loggerError).toHaveBeenCalledWith('Rest: validador inválido - não é um schema zod');
  });
});

describe('Rest.Request', () => {
  it('chama o fetch com as opções montadas e devolve a Response crua', async () => {
    const crua = resposta({}, 500);
    servidorResponde(crua);

    expect(await Rest.Request(URL_API, { a: 1 }, { method: 'POST' })).toBe(crua);
    expect(chamadas()).toEqual([
      { url: URL_API, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
    ]);
  });

  it('loga em debug só URL e verbo - headers e corpo levam segredos', async () => {
    servidorResponde(resposta({}));

    await Rest.Request(URL_API, { senha: 'x' }, { method: 'POST' }, { Authorization: 'Bearer tok' });

    expect(mocks.loggerDebug).toHaveBeenCalledWith({ url: URL_API, metodo: 'POST' }, 'Rest: requisição');
  });

  it('propaga a falha do fetch - quem trata é o RequestLogger', async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(Rest.Request(URL_API, null, {})).rejects.toThrow('fetch failed');
  });
});

describe('Rest.RequestLogger', () => {
  it('sucesso: devolve o corpo lido, status e headers', async () => {
    servidorResponde(resposta({ protocolo: 'P-1' }, 201, 'Created'));

    const retorno = await Rest.RequestLogger(URL_API, { a: 1 }, { method: 'POST' });

    expect(retorno).toEqual({
      ok: true,
      data: { protocolo: 'P-1' },
      status: 201,
      statusText: 'Created',
      url: URL_API,
      payload: { a: 1 },
      headers: expect.any(Headers),
    });
    expect(retorno.headers?.get('content-type')).toBe('application/json');
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('sucesso sem statusText (HTTP/2) cai em "Sucesso"', async () => {
    servidorResponde(new Response('{}', { status: 200, statusText: '' }));

    expect((await Rest.RequestLogger(URL_API, null, {})).statusText).toBe('Sucesso');
  });

  it('status fora de 2xx: data null, statusText do servidor e log de erro', async () => {
    servidorResponde(resposta({ erro: 'x' }, 500, 'Internal Server Error'));

    const retorno = await Rest.RequestLogger(URL_API, null, {});

    expect(retorno).toMatchObject({ ok: false, data: null, status: 500, statusText: 'Internal Server Error' });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      { url: URL_API, status: 500, statusText: 'Internal Server Error' },
      'Rest: resposta fora de 2xx',
    );
  });

  it('erro sem statusText cai em texto genérico', async () => {
    servidorResponde(new Response('', { status: 502, statusText: '' }));

    expect((await Rest.RequestLogger(URL_API, null, {})).statusText).toBe('Erro de status desconhecido');
  });

  it.each<[string, unknown, string]>([
    ['falha de rede', new TypeError('fetch failed'), 'Erro de conexão'],
    ['timeout do signal', new DOMException('estourou', 'TimeoutError'), 'Tempo esgotado'],
    ['abort manual', new DOMException('abortado', 'AbortError'), 'Requisição abortada'],
  ])('%s: não lança e devolve status 0 com "%s"', async (_rotulo, erro, statusText) => {
    mocks.fetch.mockRejectedValueOnce(erro);

    const retorno = await Rest.RequestLogger(URL_API, { a: 1 }, {});

    expect(retorno).toEqual({ ok: false, data: null, status: 0, statusText, url: URL_API, payload: { a: 1 } });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      { url: URL_API, erro: (erro as Error).message },
      `Rest: ${statusText}`,
    );
  });

  it('falha sem objeto de erro loga "desconhecido"', async () => {
    mocks.fetch.mockRejectedValueOnce(undefined);

    await Rest.RequestLogger(URL_API, null, {});

    expect(mocks.loggerError).toHaveBeenCalledWith({ url: URL_API, erro: 'desconhecido' }, 'Rest: Erro de conexão');
  });
});

describe('Rest - verbos sem corpo', () => {
  it('GET envia headers e nenhum body', async () => {
    servidorResponde(resposta({}));

    await Rest.GET(URL_API, { Authorization: 'Bearer tok' });

    expect(chamadas()).toEqual([
      {
        url: URL_API,
        method: 'GET',
        headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
        body: undefined,
      },
    ]);
  });

  it('DELETE não envia body e devolve o corpo da resposta, se houver', async () => {
    servidorResponde(resposta({ removido: true }));

    const retorno = await Rest.DELETE(URL_API);

    expect(chamadas()[0]).toMatchObject({ method: 'DELETE', body: undefined });
    expect(retorno.data).toEqual({ removido: true });
  });

  it('DELETE com 204 devolve ok e data null', async () => {
    servidorResponde(new Response(null, { status: 204, statusText: 'No Content' }));

    expect(await Rest.DELETE(URL_API)).toMatchObject({ ok: true, status: 204, data: null });
  });

  it('HEAD não lê corpo e expõe os headers da resposta', async () => {
    servidorResponde(new Response(null, { status: 200, headers: { 'Content-Length': '1024' } }));

    const retorno = await Rest.HEAD(URL_API);

    expect(chamadas()[0]).toMatchObject({ method: 'HEAD', body: undefined });
    expect(retorno.data).toBeNull();
    expect(retorno.headers?.get('content-length')).toBe('1024');
  });

  it('OPTIONS não envia body e expõe o header Allow', async () => {
    servidorResponde(new Response(null, { status: 204, headers: { Allow: 'GET, POST' } }));

    const retorno = await Rest.OPTIONS(URL_API);

    expect(chamadas()[0]).toMatchObject({ method: 'OPTIONS', body: undefined });
    expect(retorno.headers?.get('allow')).toBe('GET, POST');
  });
});

describe('Rest - verbos com corpo', () => {
  it.each(['POST', 'PUT', 'PATCH'] as const)('%s envia o payload serializado e os headers', async (metodo) => {
    servidorResponde(resposta({}));

    const retorno = await Rest[metodo](URL_API, { clienteId: 7 }, { 'token-id': 'tok-1' });

    expect(chamadas()).toEqual([
      {
        url: URL_API,
        method: metodo,
        headers: { 'content-type': 'application/json', 'token-id': 'tok-1' },
        body: '{"clienteId":7}',
      },
    ]);
    expect(retorno.payload).toEqual({ clienteId: 7 });
  });
});

describe('Rest - opções', () => {
  it('o verbo do atalho vence o `method` passado em options', async () => {
    servidorResponde(resposta({}));

    await Rest.GET(URL_API, undefined, { method: 'POST' });

    expect(chamadas()[0]).toMatchObject({ method: 'GET', body: undefined });
  });

  it('`options` são repassadas ao fetch', async () => {
    servidorResponde(resposta({}));
    const signal = AbortSignal.timeout(1000);

    await Rest.POST(URL_API, {}, undefined, { signal });

    expect((mocks.fetch.mock.calls[0]![1] as RequestInit).signal).toBe(signal);
  });
});

describe('Rest.Validar', () => {
  it('resposta dentro do contrato volta `ok` com o dado do parse', async () => {
    servidorResponde(resposta({ protocolo: 'P-1' }));

    expect(await Rest.Validar.Get(URL_API, ESQUEMA)).toMatchObject({
      ok: true,
      data: { protocolo: 'P-1' },
      status: 200,
      statusText: 'OK',
      url: URL_API,
    });
  });

  it('o dado é o do parse: campos fora do schema saem e transformações se aplicam', async () => {
    servidorResponde(resposta({ protocolo: 'P-1', extra: 1, total: '3' }));
    const esquema = z.object({ protocolo: z.string(), total: z.coerce.number(), origem: z.string().default('api') });

    const retorno = await Rest.Validar.Get(URL_API, esquema);

    expect(retorno.data).toEqual({ protocolo: 'P-1', total: 3, origem: 'api' });
  });

  it('resposta 2xx fora do contrato vira `ok: false`, mantém o status e loga só as issues', async () => {
    servidorResponde(resposta({ protocolo: 1, segredo: 'tok' }));

    expect(await Rest.Validar.Get(URL_API, ESQUEMA)).toMatchObject({
      ok: false,
      data: null,
      status: 200,
      statusText: 'Resposta fora do contrato',
    });
    expect(mocks.loggerError).toHaveBeenCalledWith({ issues: expect.any(Array) }, 'Rest: resposta fora do contrato');
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain('tok');
  });

  it('resposta de erro volta como a do verbo, sem passar pelo validador', async () => {
    servidorResponde(resposta({}, 404, 'Not Found'));

    expect(await Rest.Validar.Get(URL_API, ESQUEMA)).toMatchObject({ ok: false, data: null, status: 404, statusText: 'Not Found' });
    expect(mocks.loggerError).not.toHaveBeenCalledWith(expect.anything(), 'Rest: resposta fora do contrato');
  });

  it('falha de conexão volta como a do verbo, com status 0 e o motivo', async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    expect(await Rest.Validar.Post(URL_API, {}, ESQUEMA)).toMatchObject({ ok: false, data: null, status: 0, statusText: 'Erro de conexão' });
  });

  it('não lança com validador que não é schema zod: vira `ok: false`', async () => {
    servidorResponde(resposta({ protocolo: 'P-1' }));

    const retorno = await Rest.Validar.Get(URL_API, {} as unknown as typeof ESQUEMA);

    expect(retorno).toMatchObject({ ok: false, statusText: 'Resposta fora do contrato' });
    expect(mocks.loggerError).toHaveBeenCalledWith('Rest: validador inválido - não é um schema zod');
  });

  it.each([
    ['Post', 'POST'],
    ['Put', 'PUT'],
    ['Patch', 'PATCH'],
  ] as const)('Validar.%s envia o payload e valida a resposta', async (atalho, metodo) => {
    servidorResponde(resposta({ protocolo: 'P-1' }), resposta({ protocolo: 1 }));

    expect((await Rest.Validar[atalho](URL_API, { a: 1 }, ESQUEMA)).data).toEqual({ protocolo: 'P-1' });
    expect((await Rest.Validar[atalho](URL_API, { a: 1 }, ESQUEMA)).ok).toBe(false);
    expect(chamadas()[0]).toMatchObject({ method: metodo, body: '{"a":1}' });
  });

  it.each([
    ['Get', 'GET'],
    ['Delete', 'DELETE'],
  ] as const)('Validar.%s não envia body e valida a resposta', async (atalho, metodo) => {
    servidorResponde(resposta({ protocolo: 'P-1' }), resposta({}));

    expect((await Rest.Validar[atalho](URL_API, ESQUEMA)).data).toEqual({ protocolo: 'P-1' });
    expect((await Rest.Validar[atalho](URL_API, ESQUEMA)).ok).toBe(false);
    expect(chamadas()[0]).toMatchObject({ method: metodo, body: undefined });
  });

  it('headers e options chegam ao fetch depois do validador', async () => {
    servidorResponde(resposta({ protocolo: 'P-1' }));
    const signal = AbortSignal.timeout(1000);

    await Rest.Validar.Post(URL_API, { a: 1 }, ESQUEMA, { 'token-id': 'tok' }, { signal });

    expect(chamadas()[0]?.headers).toEqual({ 'content-type': 'application/json', 'token-id': 'tok' });
    expect((mocks.fetch.mock.calls[0]![1] as RequestInit).signal).toBe(signal);
  });

  it('duas chamadas em sequência: a chave troca pelo token e o token vai no header da segunda', async () => {
    servidorResponde(resposta({ token: 'tok-1' }), resposta({ protocolo: 'P-1' }));
    const esquemaToken = z.object({ token: z.string() });

    const auth = await Rest.Validar.Post('https://auth.parceiro.example/token', { apiKey: 'chave' }, esquemaToken);
    if (!auth.ok) throw new Error('autenticação deveria passar');
    const resultado = await Rest.Validar.Post(URL_API, { a: 1 }, ESQUEMA, { Authorization: `Bearer ${auth.data.token}` });

    expect(resultado.data).toEqual({ protocolo: 'P-1' });
    expect(chamadas().map((c) => c.headers)).toEqual([
      { 'content-type': 'application/json' },
      { 'content-type': 'application/json', authorization: 'Bearer tok-1' },
    ]);
  });
});
