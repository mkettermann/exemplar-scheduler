import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Sem autenticação de propósito — é isso que o liveness/readiness
 * probe do AKS vai chamar constantemente.
 */
export const getHealth = async (_req: FastifyRequest, _reply: FastifyReply) => {
  return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
};