import type { FastifyReply, FastifyRequest } from 'fastify';
import { checkDbHealth } from '../../db/mssql.js';
import { env } from '../../config/env.js';
import { logger } from '../../logger/logger.js';

export interface LivenessResponse {
  status: 'ok';
  uptimeSeconds: number;
}

export interface ReadinessResponse {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  checks: {
    database: { ok: boolean; latencyMs: number; error?: string };
  };
}

/**
 * Liveness — "o processo está vivo?".
 *
 * Sem autenticação de propósito: é isto que o liveness probe do AKS
 * chama constantemente. NÃO consulta o banco: se consultasse, uma queda
 * momentânea do MSSQL faria o Kubernetes matar e recriar o pod em loop,
 * transformando um problema de banco em um problema de disponibilidade.
 */
export const getHealth = async (_req: FastifyRequest, _reply: FastifyReply): Promise<LivenessResponse> => {
  return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
};

/**
 * Readiness — "o processo consegue trabalhar?".
 *
 * Aqui sim as dependências externas são verificadas. Responde 200 quando
 * tudo está de pé e 503 quando alguma dependência está fora, para o AKS
 * tirar o pod do balanceamento sem reiniciá-lo.
 *
 * Em produção a mensagem de erro do banco fica só no log: ela costuma
 * conter host e nome de instância, que não precisam ir para a resposta.
 */
export const getReadiness = async (_req: FastifyRequest, reply: FastifyReply): Promise<ReadinessResponse> => {
  const database = await checkDbHealth();
  const detalhe = database.error;

  if (!database.ok) {
    logger.error({ check: 'database', latencyMs: database.latencyMs, detalhe }, 'Readiness falhou');
  }

  reply.code(database.ok ? 200 : 503);

  return {
    status: database.ok ? 'ok' : 'degraded',
    uptimeSeconds: Math.floor(process.uptime()),
    checks: {
      database: {
        ok: database.ok,
        latencyMs: database.latencyMs,
        ...(env.NODE_ENV !== 'production' && detalhe !== undefined ? { error: detalhe } : {}),
      },
    },
  };
};
