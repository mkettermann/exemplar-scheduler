import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from './routes.js';
import { aplicarGuardaSomenteLeitura } from './plugins/read-only.js';

/**
 * Monta a instância Fastify sem subir o servidor.
 *
 * Separado de `server.ts` justamente para os testes: o vitest chama
 * `buildApp()` e usa `app.inject()` para bater nas rotas sem abrir
 * porta TCP nenhuma.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // usamos nosso próprio pino, não o do fastify
    // Sem rota de escrita, não há corpo legítimo para receber.
    bodyLimit: 1024,
    // O AKS/ingress é quem fala com o cliente real; confiar no proxy
    // faz `req.ip` refletir o cliente e não o balanceador.
    trustProxy: true,
  });

  aplicarGuardaSomenteLeitura(app);
  await app.register(registerRoutes);

  return app;
}
