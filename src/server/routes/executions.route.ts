import type { FastifyRequest } from 'fastify';
import { listRecentExecutions } from '../../repository/execution-log.repository';

export const getExecutions = async (req: FastifyRequest) => {
  const limit = Number((req.query as { limit?: string }).limit ?? 50);
  return listRecentExecutions(limit);
};