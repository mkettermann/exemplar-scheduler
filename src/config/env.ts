import { z } from 'zod';

/**
 * Flag booleana explícita: `z.coerce.boolean()` seguiria a regra do JavaScript
 * e leria `'false'` como `true`. Valor fora do conjunto derruba o boot.
 * Ver `docs/02-configuracao-de-ambiente.md`.
 */
const booleano = z
  .enum(['true', 'false', '1', '0'])
  .transform((valor) => valor === 'true' || valor === '1');

/**
 * Variáveis de ambiente do serviço, validadas no momento do import.
 * Ver `docs/02-configuracao-de-ambiente.md` para a tabela completa e para o
 * motivo de o processo morrer no boot quando algo não bate com o schema.
 */
const esquemaAmbiente = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  /** Desligada, nenhum job é registrado no boot — ver `docs/05-scheduler.md`. */
  JOBS_ENABLED: booleano.default('true'),

  DB_SERVER: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(1433),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_ENCRYPT: z.coerce.boolean().default(true),

  HEALTH_DB_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
});

export type Ambiente = z.infer<typeof esquemaAmbiente>;

function carregarAmbiente(): Ambiente {
  const resultado = esquemaAmbiente.safeParse(process.env);

  if (!resultado.success) {
    console.error('Variáveis de ambiente inválidas:', resultado.error.flatten().fieldErrors);
    process.exit(1);
  }

  return resultado.data;
}

export const ambiente = carregarAmbiente();
