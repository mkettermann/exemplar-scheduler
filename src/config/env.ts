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
  /**
   * Os quatro ambientes de deploy, mais `test`: o vitest injeta `NODE_ENV=test`
   * sozinho e sem ele no enum a validação mataria o worker — ver
   * `docs/09-testes.md`. `test` não é um destino de deploy.
   */
  NODE_ENV: z.enum(['development', 'test', 'qa', 'hml', 'production']).default('development'),
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

/**
 * `true` quando `NODE_ENV` não foi injetada e o `.default('development')`
 * assumiu por ela. Importa porque a identidade do ambiente passou a decidir
 * quais jobs rodam (`DefinicaoJob.ambientes`): um deploy que esquece de
 * injetá-la não dispara nada, e isso precisa aparecer no log do boot em vez
 * de passar por "nenhum job agendado hoje". Ver `docs/05-scheduler.md`.
 */
export const ambienteAssumido = process.env.NODE_ENV === undefined;
