import { z } from 'zod';
import { appInsightsInstance } from '../../config/appInsights.js';
import { ambiente } from '../../config/env.js';
import { Rest } from '../../shared/uteis/fetch_uteis.js';

/**
 * MODELO de serviço com POST autenticado em sistema externo - um serviço, um
 * envio, duas chamadas pelo `Rest.Validar`: `autenticar` troca a apiKey por um
 * token temporário e a exportada `enviarRegistro` faz o POST com ele no header
 * `token-id`. As decisões por trás do formato estão em
 * `docs/12-exemplo-job-e-servico.md`.
 */
const URL_AUTENTICACAO = 'https://auth.parceiro.example/api/v1/token';
const URL_ENVIO = 'https://api.parceiro.example/api/v1/registros';
const TEMPO_LIMITE_MS = 10_000;

export interface RegistroEnvio {
  clienteId: number;
  mensagem: string;
}

export interface ResultadoEnvio {
  protocolo: string;
}

const esquemaAutenticacao = z.object({ token: z.string().min(1) });
const esquemaResultado = z.object({ protocolo: z.string().min(1) });

/** Um `AbortSignal.timeout` novo por chamada: o prazo começa a contar no envio. */
function comTempoLimite() {
  return { signal: AbortSignal.timeout(TEMPO_LIMITE_MS) };
}

async function autenticar(): Promise<string> {
  const apiKey = ambiente.EXAMPLE_ENVIO_API_KEY;

  if (!apiKey) {
    throw new Error('EXAMPLE_ENVIO_API_KEY ausente - autenticacao impossivel');
  }

  const resposta = await Rest.Validar.Post(URL_AUTENTICACAO, { apiKey }, esquemaAutenticacao, undefined, comTempoLimite());

  if (!resposta.ok) {
    throw new Error(`Autenticacao falhou (status ${resposta.status}): ${resposta.statusText}`);
  }

  return resposta.data.token;
}

export async function enviarRegistro(registro: RegistroEnvio): Promise<ResultadoEnvio> {
  appInsightsInstance.trackTrace('enviarRegistro: autenticando');

  const token = await autenticar();

  appInsightsInstance.trackTrace('enviarRegistro: enviando');

  const resposta = await Rest.Validar.Post(URL_ENVIO, registro, esquemaResultado, { 'token-id': token }, comTempoLimite());

  if (!resposta.ok) {
    throw new Error(`Envio falhou (status ${resposta.status}): ${resposta.statusText}`);
  }

  appInsightsInstance.trackTrace(`enviarRegistro: concluído com protocolo ${resposta.data.protocolo}`);

  return resposta.data;
}
