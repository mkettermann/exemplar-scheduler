import type { FastifyInstance } from 'fastify';

const METODOS_PERMITIDOS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Recusa com 405 qualquer verbo de escrita, antes do roteamento e de qualquer
 * handler. Ver `docs/07-servidor-http.md` — inclusive por que o hook é
 * registrado direto em `construirApp` e não por `app.register`.
 */
export function aplicarGuardaSomenteLeitura(app: FastifyInstance): void {
  app.addHook('onRequest', async (requisicao, resposta) => {
    if (!METODOS_PERMITIDOS.has(requisicao.method)) {
      await resposta.code(405).send({
        error: 'method_not_allowed',
        message: 'Este serviço é somente leitura — apenas GET e HEAD são aceitos.',
      });
    }
  });
}
