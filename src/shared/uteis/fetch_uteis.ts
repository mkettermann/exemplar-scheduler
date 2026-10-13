import type { z, ZodTypeAny } from 'zod';
import { ambiente } from '../../config/env.js';
import { logger } from '../../logger/logger.js';

/**
 * Facilitador REST sobre o `fetch` nativo: atalhos por verbo HTTP, resposta
 * normalizada em `RestResposta` (nunca lança) e o grupo `Rest.Validar`, que
 * confere o contrato da resposta com um schema zod. Regras de cada verbo,
 * compatibilidade com o legado e exemplos em `docs/14-cliente-rest.md`.
 */
interface RestRespostaBase {
  status: number;
  statusText: string;
  url: string;
  // `any` mantido por compatibilidade com quem já lê `payload` nos jobs.
  payload: any;
  headers?: Headers;
}

// União por `ok`: depois de checar `ok`, o `data` já vem tipado e sem `null`.
export type RestResposta<T = unknown> =
  | (RestRespostaBase & { ok: true; data: T })
  | (RestRespostaBase & { ok: false; data: null });

export type MetodoHttp = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

type OpcoesRest = Partial<RequestInit>;
type HeadersRest = Record<string, string>;

// Verbos que não enviam corpo; o motivo de cada um está no capítulo 14.
const METODOS_SEM_CORPO: ReadonlySet<string> = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);

export class Rest {

  // ---------------------
  // Com validação de contrato: a mesma `RestResposta` dos verbos, com `data`
  // tipado pelo schema. Resposta 2xx fora do contrato vira `ok: false`.
  // ---------------------
  static readonly Validar = {
    Get: <S extends ZodTypeAny>(url: string, validador: S, headers?: HeadersRest, options?: OpcoesRest) =>
      validarResposta(Rest.GET(url, headers, options), validador),

    Post: <S extends ZodTypeAny>(url: string, payload: unknown, validador: S, headers?: HeadersRest, options?: OpcoesRest) =>
      validarResposta(Rest.POST(url, payload, headers, options), validador),

    Put: <S extends ZodTypeAny>(url: string, payload: unknown, validador: S, headers?: HeadersRest, options?: OpcoesRest) =>
      validarResposta(Rest.PUT(url, payload, headers, options), validador),

    Patch: <S extends ZodTypeAny>(url: string, payload: unknown, validador: S, headers?: HeadersRest, options?: OpcoesRest) =>
      validarResposta(Rest.PATCH(url, payload, headers, options), validador),

    Delete: <S extends ZodTypeAny>(url: string, validador: S, headers?: HeadersRest, options?: OpcoesRest) =>
      validarResposta(Rest.DELETE(url, headers, options), validador),
  } as const;

  // ---------------------
  // Verbos: devolvem a `RestResposta` completa.
  // ---------------------
  static readonly GET = (url: string, headers?: HeadersRest, options?: OpcoesRest) =>
    Rest.RequestLogger(url, null, { ...options, method: 'GET' }, headers);

  static readonly HEAD = (url: string, headers?: HeadersRest, options?: OpcoesRest) =>
    Rest.RequestLogger(url, null, { ...options, method: 'HEAD' }, headers);

  static readonly POST = (url: string, payload: unknown, headers?: HeadersRest, options?: OpcoesRest) =>
    Rest.RequestLogger(url, payload, { ...options, method: 'POST' }, headers);

  static readonly PUT = (url: string, payload: unknown, headers?: HeadersRest, options?: OpcoesRest) =>
    Rest.RequestLogger(url, payload, { ...options, method: 'PUT' }, headers);

  static readonly PATCH = (url: string, payload: unknown, headers?: HeadersRest, options?: OpcoesRest) =>
    Rest.RequestLogger(url, payload, { ...options, method: 'PATCH' }, headers);

  static readonly DELETE = (url: string, headers?: HeadersRest, options?: OpcoesRest) =>
    Rest.RequestLogger(url, null, { ...options, method: 'DELETE' }, headers);

  static readonly OPTIONS = (url: string, headers?: HeadersRest, options?: OpcoesRest) =>
    Rest.RequestLogger(url, null, { ...options, method: 'OPTIONS' }, headers);

  // ---------------------
  // Genérico: faz a requisição e normaliza sucesso, status de erro e falha de
  // conexão no mesmo formato. Não lança.
  // ---------------------
  static readonly RequestLogger = async (url: string, payload: unknown, options: OpcoesRest, headers?: HeadersRest): Promise<RestResposta> => {
    let resposta: Response;
    try {
      resposta = await Rest.Request(url, payload, options, headers);
    } catch (error_) {
      const statusText = motivoDaFalha(error_);
      logger.error({ url, erro: (error_ as Error | undefined)?.message ?? 'desconhecido' }, `Rest: ${statusText}`);
      return { ok: false, data: null, status: 0, statusText, url, payload };
    }

    const base = { status: resposta.status, url, payload, headers: resposta.headers };

    if (!resposta.ok) {
      logger.error({ url, status: resposta.status, statusText: resposta.statusText }, 'Rest: resposta fora de 2xx');
      return { ...base, ok: false, data: null, statusText: resposta.statusText || 'Erro de status desconhecido' };
    }

    return { ...base, ok: true, data: await lerCorpo(resposta, options.method), statusText: resposta.statusText || 'Sucesso' };
  };

  // `fetch` cru, com as opções montadas por `getFetchOptions`.
  static readonly Request = (url: string, payload: unknown, options: OpcoesRest, headers?: HeadersRest): Promise<Response> => {
    const requestInit = getFetchOptions(payload, options, headers);
    // Só URL e verbo: headers e corpo carregam tokens e dados de cliente.
    logger.debug({ url, metodo: requestInit.method }, 'Rest: requisição');
    return fetch(url, requestInit);
  };
}

// Resposta de erro passa adiante como veio, sem tocar no schema. O `data` de
// sucesso é o resultado do `parse`: campos fora do schema saem e as
// transformações (`coerce`, `default`) são aplicadas.
async function validarResposta<S extends ZodTypeAny>(pedido: Promise<RestResposta>, validador: S): Promise<RestResposta<z.output<S>>> {
  const resposta = await pedido;
  if (!resposta.ok) return resposta;

  const contrato = conferirContrato(validador, resposta.data);
  if (!contrato.success) {
    return { ...resposta, ok: false, data: null, statusText: 'Resposta fora do contrato' };
  }
  return { ...resposta, data: contrato.data };
}

// ---------------------
// FETCH OPTIONS
// - Padrão GET com `Content-Type: application/json`.
// - Headers somam na ordem: padrão < `options.headers` < `headers`; o último vence.
// - Verbos sem corpo nunca enviam body; os demais enviam o payload em JSON.
// - Sem `options.signal`, a chamada ganha o prazo de `REST_TIMEOUT_MS`; um
//   `signal` próprio substitui o padrão, para mais ou para menos.
// ---------------------
export function getFetchOptions(payload: unknown, options?: OpcoesRest, headers?: HeadersRest): RequestInit {
  const { headers: headersDasOpcoes, body: _bodyIgnorado, signal, ...resto } = options ?? {};
  const metodo = (options?.method ?? 'GET').toUpperCase();
  const fetchOptions: RequestInit = {
    ...resto,
    method: metodo,
    headers: mesclarHeaders({ 'Content-Type': 'application/json' }, headersDasOpcoes, headers),
    // Criado aqui, a cada chamada: o prazo começa a contar no envio.
    signal: signal ?? AbortSignal.timeout(ambiente.REST_TIMEOUT_MS),
  };
  if (!METODOS_SEM_CORPO.has(metodo)) {
    fetchOptions.body = JSON.stringify(payload);
  }
  return fetchOptions;
}

function mesclarHeaders(...fontes: RequestInit['headers'][]): Headers {
  const resultado = new Headers();
  for (const fonte of fontes) {
    new Headers(fonte).forEach((valor, chave) => resultado.set(chave, valor));
  }
  return resultado;
}

// ---------------------
// Validação de contrato com zod. Loga só as issues, nunca o objeto: a resposta
// pode trazer token ou dado de cliente.
// ---------------------
export function validarRetornoZod(validador: ZodTypeAny, objASerVerificado: unknown): boolean {
  return conferirContrato(validador, objASerVerificado).success;
}

function conferirContrato<S extends ZodTypeAny>(
  validador: S,
  dado: unknown,
): { success: true; data: z.output<S> } | { success: false } {
  if (typeof validador?.safeParse !== 'function') {
    logger.error('Rest: validador inválido - não é um schema zod');
    return { success: false };
  }
  const resultado = validador.safeParse(dado);
  if (!resultado.success) {
    logger.error({ issues: resultado.error.issues }, 'Rest: resposta fora do contrato');
  }
  return resultado;
}

// ---------------------
// Leitura do corpo de uma resposta 2xx
// - Vazio (204, HEAD) → null.
// - Binário (pdf, imagem, octet-stream) → Blob.
// - Texto → JSON quando interpretável, senão a string.
// ---------------------
export async function getFetchResponse(response: Response): Promise<unknown> {
  try {
    if (!corpoEhTexto(response.headers.get('content-type'))) {
      return await response.blob();
    }
    const texto = await response.text();
    return texto === '' ? null : interpretarTexto(texto);
  } catch {
    return null;
  }
}

async function lerCorpo(resposta: Response, metodo?: string): Promise<unknown> {
  // HEAD não tem corpo por definição; o que interessa está em `headers`.
  if (metodo?.toUpperCase() === 'HEAD') return null;
  return getFetchResponse(resposta);
}

function corpoEhTexto(contentType: string | null): boolean {
  if (!contentType) return true;
  const tipo = contentType.toLowerCase();
  return ['text/', 'json', 'xml', 'javascript', 'x-www-form-urlencoded'].some((marca) => tipo.includes(marca));
}

function interpretarTexto(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

function motivoDaFalha(erro: unknown): string {
  const nome = (erro as Error | undefined)?.name;
  if (nome === 'TimeoutError') return 'Tempo esgotado';
  if (nome === 'AbortError') return 'Requisição abortada';
  return 'Erro de conexão';
}
