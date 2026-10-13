import type z from "zod";
import { Util } from "../../util/util.js";
import { logger } from "../../logger/logger.js";

export interface RestResposta {
  ok: boolean,
  data: unknown | null,
  status: number,
  statusText: string,
  url: string,
  payload: any,
}

// Facilitador REST (Genérico, Atalhos REST e Atalho Enviar/Solicitar com Validação Zod)
export class Rest {

  // ENVIAR com validador (Padrão POST)
  static POST_Valido = async <T>(url: string, payload: any, headers?: Record<string, string>, validador?: z.ZodObject<any>, options?: Partial<RequestInit>): Promise<T | null> => {
    let retornou = await Rest.POST(url, payload, headers, options);
    if (retornou.ok == true && validador != null) {
      if (!validarRetornoZod(validador, retornou.data)) {
        return null;
      }
    }
    return retornou.data as T;
  }

  // SOLICITAR com validador (Padrão GET)
  static GET_Valido = async <T>(url: string, headers?: Record<string, string>, validador?: z.ZodObject<any>, options?: Partial<RequestInit>): Promise<T | null> => {
    let retornou = await Rest.GET(url, headers, options);
    if (retornou.ok == true && validador != null) {
      if (!validarRetornoZod(validador, retornou.data)) {
        return null;
      }
    }
    return retornou.data as T;
  }



  // METODOS API REST
  static POST = async (url: string, payload: any, headers?: Record<string, string>, options?: Partial<RequestInit>) => {
    return await Rest.RequestLogger(url, payload, { method: 'POST', ...options }, headers)
  }
  static GET = async (url: string, headers?: Record<string, string>, options?: Partial<RequestInit>) => {
    return await Rest.RequestLogger(url, null, { method: 'GET', ...options }, headers)
  }
  static PUT = async (url: string, headers?: Record<string, string>, options?: Partial<RequestInit>) => {
    return await Rest.RequestLogger(url, null, { method: 'PUT', ...options }, headers)
  }
  static DELETE = async (url: string, headers?: Record<string, string>, options?: Partial<RequestInit>) => {
    return await Rest.RequestLogger(url, null, { method: 'DELETE', ...options }, headers)
  }
  static PATCH = async (url: string, headers?: Record<string, string>, options?: Partial<RequestInit>) => {
    return await Rest.RequestLogger(url, null, { method: 'PATCH', ...options }, headers)
  }
  static OPTIONS = async (url: string, headers?: Record<string, string>, options?: Partial<RequestInit>) => {
    return await Rest.RequestLogger(url, null, { method: 'OPTIONS', ...options }, headers)
  }

  // API REST Genérico com Logger (Console)
  // INCLUI Logger
  // INCLUI Body já lido (ver getFetchResponse)...
  static RequestLogger = async (url: string, payload: any, options: Partial<RequestInit>, headers?: Record<string, string>): Promise<RestResposta> => {
    let retorno: Response | null = null; // Sem retorno
    let statusText: string = 'Desconhecido';

    try {
      retorno = await Rest.Request(url, payload, options, headers);
    } catch (error_: any) { // Normalmente sem conexão entre origem e destino.
      // FALHOU (0 CONEXÃO)
      statusText = 'Erro de conexão';
      logger.error(`Request falhou: ${url}. Erro: ${error_?.message ?? 'desconhecido'}`);
      console.log(`Exibir erro de erro de Falha:`, error_);
    }

    if (retorno && retorno.ok != true) {
      // FALHOU (STATUS NÃO É 200-299)
      logger.error(`${Util.corVermelho(String(retorno?.status))} - Request retornou: ${retorno?.statusText}`);
      statusText = retorno?.statusText ?? 'Conexão com erro de status desconhecido';
    }
    if (retorno && retorno.ok == true) {
      // SUCESSO (200-299)
      statusText = retorno?.statusText ?? 'Sucesso';
    }
    return {
      ok: retorno?.ok ?? false,
      data: retorno?.ok ? await getFetchResponse(retorno) : null,
      status: retorno?.status ?? 0,
      statusText: statusText,
      url,
      payload
    };
  }

  // API REST Genérico (FETCH)
  static Request = async (url: string, payload: any, options: Partial<RequestInit>, headers?: Record<string, string>): Promise<Response> => {
    let requestInit = getFetchOptions(payload, options, headers);
    console.log(` >> FETCHING URL: ${url}:\n >> F. OPTIONS: `, requestInit)
    return await fetch(url, requestInit);
  }

}

// ---------------------
// FETCH OPTIONS 
// - Permite diversificar uma mesma consulta fetch
// - Padrao options GET de JSON.
// - Quando é GET, não inclui Body.
// - Quando não é GET, já realiza a conversão do Body em String pro pacote de rede.
// ---------------------
export function getFetchOptions(
  payload: any,
  options?: Partial<RequestInit>,
  headers?: Record<string, string>
) {
  let headersInit: Headers = new Headers({ 'Content-Type': 'application/json' });
  if (headers) {
    for (let [key, value] of Object.entries(headers)) {
      headersInit.append(key, value)
    }
  }
  let fetchOptions: RequestInit = {
    method: 'GET',
    headers: headersInit,
    ...options
  }
  if (fetchOptions.method != 'GET') {
    fetchOptions.body = JSON.stringify(payload)
  }
  return fetchOptions;
}


// ---------------------
// Função de validar 
// ---------------------
export function validarRetornoZod(validador: z.ZodObject<any>, objASerVerificado: any): boolean {
  if (Util.classOf(validador) != 'object' || !validador.hasOwnProperty('parse')) {
    logger.error('(Validador) O Validador é INVALIDO.');
    return false;
  }
  try {
    validador.parse(objASerVerificado);
    return true;
  } catch (error_: any) {
    if (error_.hasOwnProperty('issues')) {
      logger.error({ Invalidado: error_.issues, objASerVerificado }, '(Validador Retorno) Formato Invalido.');
    }
  }
  return false;
}

// ---------------------
// Função unificar possibilidades de coleta.
// ---------------------
export async function getFetchResponse(response: Response): Promise<null | unknown> {
  let resposta = await tryGetJsonFromFetch(response); // 1. JSON ?
  if (response === null) resposta = await tryGetBlobFromFetch(response); // 2. BLOB ?
  if (response === null) resposta = await tryGetTextFromFetch(response); // 3. TEXT ?
  if (response === null) resposta = null;
  return resposta;
}

async function tryGetJsonFromFetch(response: Response): Promise<null | unknown> {
  try {
    return await response.json();
  } catch (error_) {
    // Não coleta o catch, mas não é um JSON legivel.
    return null;
  }
}

async function tryGetTextFromFetch(response: Response): Promise<null | unknown> {
  try {
    return await response.text();
  } catch (error_) {
    // Não coleta o catch, mas não é um TEXT legivel.
    return null;
  }
}

async function tryGetBlobFromFetch(response: Response): Promise<null | unknown> {
  try {
    return await response.blob();
  } catch (error_) {
    // Não coleta o catch, mas não é um BLOB legivel.
    return null;
  }
}
