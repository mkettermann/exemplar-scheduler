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
      'não pode começar nem terminar com espaço ou quebra de linha - confira se o manifesto usa o bloco `|-`',
  })
  .refine((valor) => valor !== 'CHANGE_ME', {
    message: 'ainda está com o placeholder `CHANGE_ME` do `.env.example` - ajuste a variável com o valor real',
  });

/** Ver `docs/02-configuracao-de-ambiente.md` */
const esquemaAmbiente = z.object({
  /** Quatro ambientes de deploy, mais `test`. Sem default: decide quais jobs rodam - ver docs/02. */
  NODE_ENV: z.enum(['development', 'test', 'qa', 'hml', 'production'], {
    required_error: 'obrigatória - decide quais jobs este processo registra; o deploy precisa injetá-la',
  }),
  PORT: z.coerce.number().int().positive().default(3000),

  /** Ver `docs/05-scheduler.md`. */
  JOBS_ENABLED: booleano.default('true'),

  DB_SERVER: textoObrigatorio,
  DB_PORT: z.coerce.number().int().positive().default(1433),
  DB_NAME: textoObrigatorio,
  DB_USER: textoObrigatorio,
  DB_PASSWORD: textoObrigatorio,
  DB_ENCRYPT: booleano.default('true'),

  HEALTH_DB_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),

  /** Ver `docs/13-application-insights.md`. Ausente, a telemetria fica desligada. */
  APPINSIGHTSKEY: textoObrigatorio.optional(),

  /** Ver `docs/12-exemplo-job-e-servico.md` - sai junto com o exemplo. */
  EXAMPLE_ENVIO_API_KEY: textoObrigatorio.optional(),
});

export type Ambiente = z.infer<typeof esquemaAmbiente>;

/** Ambientes reais de deploy - exclui `test`, que só existe sob o vitest. */
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

export const getSiglaAmbiente = (limite: number = 3): string => {
  return ambiente.NODE_ENV.slice(0, limite).toUpperCase();
}
