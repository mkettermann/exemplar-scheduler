import type { FastifyInstance } from 'fastify';
import { obterLiveness, obterReadiness } from './routes/health.route.js';

/**
 * Mapa explícito de método, rota e handler: todo endpoint do serviço aparece
 * aqui. Regra da casa: só GET, e só observabilidade.
 * Ver `docs/07-servidor-http.md`.
 */
export async function registrarRotas(app: FastifyInstance): Promise<void> {
  app.get('/health', obterLiveness);
  app.get('/health/ready', obterReadiness);
}
