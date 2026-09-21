import Fastify, { type FastifyInstance } from 'fastify';
import { registrarRotas } from './routes.js';
import { aplicarGuardaSomenteLeitura } from './plugins/read-only.js';

/**
 * Monta a instância Fastify sem subir o servidor — é o que permite aos testes
 * usarem `app.inject()` sem abrir porta. As opções passadas ao Fastify e o
 * motivo de a guarda ser aplicada fora de `register` estão em
 * `docs/07-servidor-http.md`.
 */
export async function construirApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 1024,
    trustProxy: true,
  });

  aplicarGuardaSomenteLeitura(app);
  await app.register(registrarRotas);

  return app;
}
