import type { FastifyInstance } from 'fastify';
import { getHealth } from './routes/health.route';
import { getExecutions } from './routes/executions.route';
import { requireAdminKey } from './middlewares/require-admin-keu';

/**
 * Mapa explícito de método + rota + handler. Todo endpoint do serviço
 * aparece aqui — não precisa entrar em cada arquivo de rota para saber
 * o que existe, só para saber COMO cada um funciona por dentro.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
	app.get('/health', getHealth);
	app.get('/admin/executions', { preHandler: requireAdminKey }, getExecutions);
}