import { z } from 'zod';

/**
 * Schema das variáveis de ambiente esperadas pelo serviço.
 *
 * Isto substitui comentário: se um valor não bater com o schema,
 * o processo falha JÁ NA INICIALIZAÇÃO com uma mensagem clara,
 * em vez de quebrar silenciosamente no meio de um job às 3h da manhã.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DB_SERVER: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(1433),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_ENCRYPT: z.coerce.boolean().default(true),

  /** Tempo máximo, em ms, que o readiness espera o banco responder antes de considerar degradado. */
  HEALTH_DB_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('Variáveis de ambiente inválidas:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();
