import { z } from 'zod';

/** Ver `docs/02-configuracao-de-ambiente.md`. */
const booleano = z
  .enum(['true', 'false', '1', '0'])
  .transform((valor) => valor === 'true' || valor === '1');

/** Ver `docs/02-configuracao-de-ambiente.md`. */
const textoObrigatorio = z
  .string()
  .min(1)
  .refine((valor) => valor === valor.trim(), {
    message:
      'não pode começar nem terminar com espaço ou quebra de linha — confira se o manifesto usa o bloco `|-`',
  });

/** Ver `docs/02-configuracao-de-ambiente.md` */
const esquemaAmbiente = z.object({
  /** Quatro ambientes de deploy, mais `test` */
  NODE_ENV: z.enum(['development', 'test', 'qa', 'hml', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  /** Ver `docs/05-scheduler.md`. */
  JOBS_ENABLED: booleano.default('true'),

  DB_SERVER: textoObrigatorio,
  DB_PORT: z.coerce.number().int().positive().default(1433),
  DB_NAME: textoObrigatorio,
  DB_USER: textoObrigatorio,
  DB_PASSWORD: textoObrigatorio,
  DB_ENCRYPT: z.coerce.boolean().default(true),

  HEALTH_DB_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
});

export type Ambiente = z.infer<typeof esquemaAmbiente>;

/** Ambientes reais de deploy — exclui `test`, que só existe sob o vitest. */
export type AmbienteDeploy = Exclude<Ambiente['NODE_ENV'], 'test'>;

function carregarAmbiente(): Ambiente {
  const resultado = esquemaAmbiente.safeParse(process.env);

  if (!resultado.success) {
    console.error('Variáveis de ambiente inválidas:', resultado.error.flatten().fieldErrors);
    process.exit(1);
  }

  return resultado.data;
}

export const ambiente = carregarAmbiente();

/** Ver `docs/05-scheduler.md`. */
export const ambienteAssumido = process.env.NODE_ENV === undefined;
