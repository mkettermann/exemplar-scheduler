import type { FastifyInstance } from 'fastify';

/**
 * Únicos verbos que este serviço aceita. A regra da arquitetura é:
 * o scheduler NUNCA recebe conteúdo de fora — ele consulta as fontes
 * que ele próprio declara no código (ver `src/services/`).
 */
const METODOS_PERMITIDOS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Trava de superfície: qualquer requisição com verbo de escrita é
 * recusada com 405 antes de chegar em qualquer handler.
 *
 * Isto existe para que a regra não dependa da disciplina de quem escreve
 * a próxima rota: mesmo que alguém registre um `app.post(...)` por engano,
 * o hook derruba a requisição antes do handler rodar.
 *
 * É chamado direto em `buildApp` (e não via `app.register`) de propósito:
 * `register` cria um escopo encapsulado e o hook não valeria para as rotas
 * registradas fora dele.
 */
export function aplicarGuardaSomenteLeitura(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!METODOS_PERMITIDOS.has(req.method)) {
      await reply.code(405).send({
        error: 'method_not_allowed',
        message: 'Este serviço é somente leitura — apenas GET e HEAD são aceitos.',
      });
    }
  });
}
