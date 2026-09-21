import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env';

/**
 * Middleware (preHandler) reutilizável: protege qualquer rota atrás
 * do header `x-admin-key`, comparando com ADMIN_API_KEY.
 *
 * Uso em routes.ts:
 *   app.get('/alguma-rota', { preHandler: requireAdminKey }, handler);
 */
export function requireAdminKey(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
	const key = req.headers['x-admin-key'];

	if (key !== env.ADMIN_API_KEY) {
		reply.code(401).send({ error: 'unauthorized' });
		return;
	}

	done();
}