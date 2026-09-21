import type { FastifyReply, FastifyRequest } from 'fastify';
import { verificarSaudeDb } from '../../db/mssql.js';
import { ambiente } from '../../config/env.js';
import { logger } from '../../logger/logger.js';

/**
 * Corpo das respostas de health. As chaves ficam em inglês por serem contrato
 * externo, lido por probes e por monitoração. Ver `docs/08-health-check.md`.
 */
export interface RespostaLiveness {
  status: 'ok';
  uptimeSeconds: number;
}

export interface RespostaReadiness {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  checks: {
    database: { ok: boolean; latencyMs: number; error?: string };
  };
}

/**
 * Liveness — "o processo está vivo?". Público e sem I/O: não consulta o banco,
 * de propósito. Ver `docs/08-health-check.md`.
 */
export const obterLiveness = async (
  _requisicao: FastifyRequest,
  _resposta: FastifyReply,
): Promise<RespostaLiveness> => {
  return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
};

/**
 * Readiness — "o processo consegue trabalhar?". Responde 200 com as
 * dependências de pé e 503 quando alguma está fora; em produção o motivo da
 * falha fica só no log. Ver `docs/08-health-check.md`.
 */
export const obterReadiness = async (
  _requisicao: FastifyRequest,
  resposta: FastifyReply,
): Promise<RespostaReadiness> => {
  const banco = await verificarSaudeDb();

  if (!banco.ok) {
    logger.error(
      { check: 'database', latencyMs: banco.latenciaMs, motivo: banco.erro },
      'Readiness falhou',
    );
  }

  resposta.code(banco.ok ? 200 : 503);

  return {
    status: banco.ok ? 'ok' : 'degraded',
    uptimeSeconds: Math.floor(process.uptime()),
    checks: {
      database: {
        ok: banco.ok,
        latencyMs: banco.latenciaMs,
        ...(ambiente.NODE_ENV !== 'production' && banco.erro !== undefined
          ? { error: banco.erro }
          : {}),
      },
    },
  };
};
