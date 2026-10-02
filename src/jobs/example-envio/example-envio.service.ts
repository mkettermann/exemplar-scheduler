import { z } from 'zod';
import { appInsightsInstance } from '../../config/appInsights.js';
import { ambiente } from '../../config/env.js';

/**
 * MODELO de serviço com POST autenticado em sistema externo - um serviço, um
 * envio, duas chamadas: `autenticar` troca a apiKey por um token temporário e
 * a exportada `enviarRegistro` faz o POST com ele no header `token-id`. As
 * decisões por trás do formato estão em `docs/12-exemplo-job-e-servico.md`.
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

async function autenticar(): Promise<string> {
  const apiKey = ambiente.EXAMPLE_ENVIO_API_KEY;

  if (!apiKey) {
    throw new Error('EXAMPLE_ENVIO_API_KEY ausente - autenticacao impossivel');
  }

  const resposta = await fetch(URL_AUTENTICACAO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
    signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
  });

  if (!resposta.ok) {
    throw new Error(`Autenticacao respondeu ${resposta.status}`);
  }

  return esquemaAutenticacao.parse(await resposta.json()).token;
}

export async function enviarRegistro(registro: RegistroEnvio): Promise<ResultadoEnvio> {
  appInsightsInstance.trackTrace('enviarRegistro: autenticando');

  const token = await autenticar();

  appInsightsInstance.trackTrace('enviarRegistro: enviando');

  const resposta = await fetch(URL_ENVIO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'token-id': token },
    body: JSON.stringify(registro),
    signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
  });

  if (!resposta.ok) {
    throw new Error(`Envio respondeu ${resposta.status}`);
  }

  const resultado = esquemaResultado.parse(await resposta.json());

  appInsightsInstance.trackTrace(`enviarRegistro: concluído com protocolo ${resultado.protocolo}`);

  return resultado;
}
