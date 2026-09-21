import { z } from 'zod';

/**
 * Schema das variáveis de ambiente esperadas pelo serviço.
 *
 * Isto substitui comentário: se um valor não bater com o schema,
 * o processo falha JÁ NA INICIALIZAÇÃO com uma mensagem clara,
 * em vez de quebrar silenciosamente no meio de um job às 3h da manhã.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DB_SERVER: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(1433),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_ENCRYPT: z.coerce.boolean().default(true),

  ADMIN_API_KEY: z.string().min(8, 'ADMIN_API_KEY precisa ter pelo menos 8 caracteres'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Variáveis de ambiente inválidas:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();
