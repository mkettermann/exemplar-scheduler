# 02 — Configuração de ambiente

[← TypeScript e build](01-typescript-e-build.md) · [Índice](README.md) · [Próximo: Logger →](03-logger.md)

## Biblioteca

| Pacote | Versão | Papel |
| --- | --- | --- |
| [`zod`](https://zod.dev/) | `^3.23` | Valida e converte as variáveis de ambiente, e deriva o tipo `Env` |

Nenhuma biblioteca de `.env` é usada. O Node ≥ 20.6 carrega arquivos `.env`
nativamente via `--env-file`, e o script `dev` já usa
`--env-file-if-exists=.env`. Em produção as variáveis vêm da biblioteca de
variáveis do Azure, injetadas pela pipeline — não existe `.env` no container.

## Responsabilidade

Ser o **único** ponto do sistema que lê `process.env`, e falhar imediatamente
se a configuração estiver errada.

```ts
// src/config/env.ts
export const env = loadEnv();
```

`loadEnv()` roda no momento do `import`. Se algo não bater com o schema, o
processo imprime quais campos falharam e chama `process.exit(1)`. Isso é
intencional: um serviço de jobs mal configurado que sobe "quase certo" só
descobre o problema quando o cron dispara, possivelmente de madrugada,
possivelmente com efeito colateral já aplicado.

## Como funciona

```ts
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DB_SERVER: z.string().min(1),
  HEALTH_DB_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof envSchema>;
```

Três coisas acontecem de uma vez:

1. **Validação** — `DB_SERVER` ausente derruba o boot com mensagem nominal.
2. **Coerção** — variáveis de ambiente são sempre string. `z.coerce.number()`
   entrega `PORT` já como `number`, então `app.listen({ port: env.PORT })`
   não precisa de `Number(...)` espalhado pelo código.
3. **Tipo** — `z.infer` deriva `Env` do schema. Não existe uma interface
   escrita à mão para sair de sincronia com a validação.

O resto do sistema só faz `import { env } from '../config/env.js'` e usa campos
tipados. Ninguém lê `process.env` diretamente.

## Variáveis atuais

| Variável | Obrigatória | Default | Para quê |
| --- | --- | --- | --- |
| `NODE_ENV` | não | `development` | Decide formato de log, TLS do banco e verbosidade do readiness |
| `PORT` | não | `3000` | Porta HTTP |
| `DB_SERVER` | **sim** | — | Host do MSSQL |
| `DB_PORT` | não | `1433` | Porta do MSSQL |
| `DB_NAME` | **sim** | — | Base de dados |
| `DB_USER` | **sim** | — | Usuário |
| `DB_PASSWORD` | **sim** | — | Senha |
| `DB_ENCRYPT` | não | `true` | TLS na conexão |
| `HEALTH_DB_TIMEOUT_MS` | não | `3000` | Teto de espera do readiness pelo banco |

> **Atenção com `z.coerce.boolean()`**: ela segue a regra do JavaScript — toda
> string não vazia vira `true`. `DB_ENCRYPT=false` resulta em **`true`**. Para
> desligar, deixe a variável vazia ou ausente. Se isso incomodar, a seção de
> upgrades mostra como trocar por um parser explícito.

## Upgrades futuros sem quebrar o que existe

**Adicionar uma variável nova** — o caminho de menor risco:

1. Adicione o campo no `envSchema`, **com `.default(...)`** se o serviço puder
   funcionar sem ele.
2. Adicione a linha no [`.env.example`](../.env.example), comentada se for opcional.
3. Registre na tabela acima.
4. Só depois peça para a pipeline injetar o valor.

Se a variável for obrigatória (sem default), a ordem se inverte: **primeiro** a
pipeline passa a injetar, **depois** o schema exige. Na ordem contrária, o
próximo deploy não sobe.

**Corrigir o comportamento de `DB_ENCRYPT`** — troque por um parser explícito,
que é compatível com os valores já em uso:

```ts
const booleano = z
  .enum(['true', 'false', '1', '0'])
  .default('true')
  .transform((v) => v === 'true' || v === '1');

DB_ENCRYPT: booleano,
```

Aplique a mesma ideia em toda flag booleana futura.

**Migrar para zod 4** — a API de erros mudou. O ponto de impacto aqui é único:
`parsed.error.flatten().fieldErrors` em `loadEnv()`. Em zod 4 o equivalente é
`z.treeifyError(parsed.error)`. Como todo o uso de zod está concentrado em
`env.ts`, a migração é pequena — mas rode `npm run typecheck` antes de considerar pronta.

**Trocar por variáveis vindas do Azure Key Vault** — mantenha o `envSchema`
como está e resolva os segredos **antes** de importar qualquer coisa de `src/`,
escrevendo-os em `process.env`. A alternativa (tornar `env` assíncrono)
contaminaria todos os módulos que hoje fazem `import { env }` no topo, e é o
tipo de mudança que quebra o sistema inteiro de uma vez.

**Nunca** logue o objeto `env` inteiro. O [logger](03-logger.md) já censura
`DB_PASSWORD`, mas confiar no redact é a segunda linha de defesa, não a
primeira.
