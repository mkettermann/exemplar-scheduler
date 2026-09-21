import type { FastifyInstance } from 'fastify';
import { getHealth, getReadiness } from './routes/health.route.js';

/**
 * Mapa explícito de método + rota + handler. Todo endpoint do serviço
 * aparece aqui — não precisa entrar em cada arquivo de rota para saber
 * o que existe, só para saber COMO cada um funciona por dentro.
 *
 * Regra da casa: só GET, e só observabilidade. O health é a única
 * superfície HTTP deste serviço.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', getHealth);
  app.get('/health/ready', getReadiness);
}
