# 02 - Configuração de ambiente

[← TypeScript e build](01-typescript-e-build.md) ·
[Índice](README.md) ·
[Próximo: Logger →](03-logger.md)

## Biblioteca

| Pacote | Versão | Papel |
| --- | --- | --- |
| [`zod`](https://zod.dev/) | `^3.23` | Valida e converte as variáveis de ambiente, e deriva o tipo `Ambiente` |

Nenhuma biblioteca de `.env` é usada. O Node ≥ 20.6 carrega arquivos `.env`
nativamente via `--env-file`, e o script `dev` já usa
`--env-file-if-exists=.env`. Em produção as variáveis vêm da biblioteca de
variáveis do Azure, injetadas pela pipeline - não existe `.env` no container.

## Responsabilidade

Ser o **único** ponto do sistema que lê `process.env`, e falhar imediatamente
se a configuração estiver errada.

```ts
// src/config/env.ts
export const ambiente = carregarAmbiente();
```

`carregarAmbiente()` roda no momento do `import`. Se algo não bater com o
schema, o processo imprime quais campos falharam e chama `process.exit(1)`.
Isso é intencional: um serviço de jobs mal configurado que sobe "quase certo"
só descobre o problema quando o cron dispara, possivelmente de madrugada,
possivelmente com efeito colateral já aplicado.

## Como funciona

```ts
const esquemaAmbiente = z.object({
  NODE_ENV: z.enum(['development', 'test', 'qa', 'hml', 'production']),
  PORT: z.coerce.number().int().positive().default(3000),
  DB_SERVER: z.string().min(1),
  HEALTH_DB_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
});

export type Ambiente = z.infer<typeof esquemaAmbiente>;
```

Três coisas acontecem de uma vez:

1. **Validação** - `DB_SERVER` ausente derruba o boot com mensagem nominal.
2. **Coerção** - variáveis de ambiente são sempre string. `z.coerce.number()`
   entrega `PORT` já como `number`, então `app.listen({ port: ambiente.PORT })`
   não precisa de `Number(...)` espalhado pelo código.
3. **Tipo** - `z.infer` deriva `Ambiente` do schema. Não existe uma interface
   escrita à mão para sair de sincronia com a validação.

O resto do sistema só faz `import { ambiente } from '../config/env.js'` e usa
campos tipados. Ninguém lê `process.env` diretamente.

## Variáveis atuais

| Variável | Obrigatória | Default | Para quê |
| --- | --- | --- | --- |
| `NODE_ENV` | **sim** | - | Ambiente de deploy: `development`, `qa`, `hml`, `production` - mais `test`, que só existe sob o vitest. Decide formato de log, TLS do banco e verbosidade do readiness |
| `PORT` | não | `3000` | Porta HTTP |
| `JOBS_ENABLED` | não | `true` | Registra ou não os jobs no boot - desligada, o serviço sobe só com o health |
| `DB_SERVER` | **sim** | - | Host do MSSQL. Sem espaço nem quebra de linha nas pontas |
| `DB_PORT` | não | `1433` | Porta do MSSQL |
| `DB_NAME` | **sim** | - | Base de dados. Sem espaço nem quebra de linha nas pontas |
| `DB_USER` | **sim** | - | Usuário. Sem espaço nem quebra de linha nas pontas |
| `DB_PASSWORD` | **sim** | - | Senha. Sem espaço nem quebra de linha nas pontas |
| `DB_ENCRYPT` | não | `true` | TLS na conexão. Aceita só `true`, `false`, `1` e `0` |
| `DB_REQUEST_TIMEOUT_MS` | não | `900000` | Teto de cada query no MSSQL; estourado, a query é cancelada no servidor - ver [capítulo 04](04-banco-de-dados.md#timeout-de-query) |
| `HEALTH_DB_TIMEOUT_MS` | não | `3000` | Teto de espera do readiness pelo banco |
| `REST_TIMEOUT_MS` | não | `180000` | Prazo de cada chamada do `Rest` que não traz `signal` próprio - ver [capítulo 14](14-cliente-rest.md#timeout) |
| `APPINSIGHTSKEY` | não | - | Connection string (ou iKey) do Application Insights. Ausente, a telemetria fica desligada - ver [capítulo 13](13-application-insights.md) |
| `OTEL_SERVICE_NAME` | não | - | Lida pelo SDK do Application Insights, não pelo `esquemaAmbiente`: vira o `cloud_RoleName` no portal. Ausente, o nome é genérico - ver [capítulo 13](13-application-insights.md#cloud_rolename) |
| `EXAMPLE_ENVIO_API_KEY` | não | - | apiKey do modelo descartável `example-envio`. Ausente, só esse serviço falha - sai junto com o exemplo, ver [capítulo 12](12-exemplo-job-e-servico.md) |

### Flags booleanas: nunca `z.coerce.boolean()`

`z.coerce.boolean()` segue a regra do JavaScript: toda string não vazia vira
`true`, e `'false'` também. Por isso `JOBS_ENABLED` e `DB_ENCRYPT` usam um
parser explícito, que aceita apenas `true`, `false`, `1` e `0`. Qualquer outro
valor - inclusive `False` ou `TRUE` - derruba o boot com mensagem nominal, em
vez de ligar jobs ou TLS por engano. Toda flag booleana nova deve reusá-lo:

```ts
const booleano = z
  .enum(['true', 'false', '1', '0'])
  .transform((valor) => valor === 'true' || valor === '1');

JOBS_ENABLED: booleano.default('true'),
DB_ENCRYPT: booleano.default('true'),
```

## `textoObrigatorio`: presença não é o bastante

Os quatro campos de conexão usam um parser próprio, que recusa espaço e quebra
de linha **nas pontas** e o placeholder `CHANGE_ME`:

```ts
const textoObrigatorio = z
  .string()
  .min(1)
  .refine((valor) => valor === valor.trim(), {
    message: 'não pode começar nem terminar com espaço ou quebra de linha - ...',
  })
  .refine((valor) => valor !== 'CHANGE_ME', {
    message: 'ainda está com o placeholder `CHANGE_ME` do `.env.example` - ajuste a variável com o valor real',
  });
```

O `.min(1)` sozinho já cobre o caso barulhento: uma substituição que resultou
em vazio derruba o boot com o nome do campo, antes de qualquer conexão. O
`refine` existe para o caso que passaria **calado**.

Num Secret do Kubernetes, o bloco `|` preserva a quebra de linha final; só o
`|-` a remove:

```yaml
stringData:
  DB_PASSWORD: |-    # correto: sem o newline final
    ${DB_PASSWORD}
```

Com `|` no lugar de `|-`, o valor vira `'senha\n'` - seis caracteres, passa
num `.min(1)` puro, e o banco recusa a conexão com uma mensagem que se lê como
*senha errada*. Alguém vai conferir o valor no Key Vault e encontrá-lo
correto. O `refine` transforma essa caça ao fantasma em um erro nomeado no
boot.

Ele **recusa em vez de aparar**, de propósito: um `.trim()` silencioso
esconderia o manifesto errado em vez de apontá-lo. E o guard é só sobre as
pontas - senha com espaço no meio é aceita sem ressalva.

Vale para todo campo que chegue por substituição em manifesto, não só para a
senha: `DB_USER` com `\n` no fim falha a autenticacao exatamente igual.

### O placeholder `CHANGE_ME`

O [`.env.example`](../.env.example) traz `CHANGE_ME` nos campos de conexão. Um
`.env` copiado sem ajuste passaria no `.min(1)` e só falharia na primeira
conexão, com um erro de host ou login que não diz qual variável esqueceram. O
segundo `refine` derruba o boot nomeando o campo e pedindo o valor real.

A comparação é **exata**: só `CHANGE_ME` é recusado. `change_me` ou uma senha
que contenha o texto no meio passam - o guard pega o placeholder, não adivinha
intenção.

## O que merece default e o que não merece

É tentador empurrar o máximo de variáveis para o `.default(...)` e reduzir o
que cada ambiente precisa declarar. O critério para decidir é único:

> Um default afirma que **"ausente" e "este valor" são igualmente seguros**.

Onde isso é verdade, o default é um ganho puro - `PORT`, `DB_PORT`,
`DB_ENCRYPT`, `DB_REQUEST_TIMEOUT_MS`, `HEALTH_DB_TIMEOUT_MS`,
`REST_TIMEOUT_MS`, `JOBS_ENABLED`.
Errar ali custa um aborrecimento local, nunca um dado errado.

Onde é falso, o default troca uma falha barulhenta por uma silenciosa. Os
quatro campos de conexão dizem **qual banco o serviço toca**, e por isso não
têm default nem devem ganhar um:

- `DB_SERVER`, `DB_NAME`, `DB_USER` - um default faria um deploy mal
  configurado apontar em silêncio para o banco de outro ambiente. Num arranjo
  em que DEV, QA e HML compartilham base ([capítulo 05](05-scheduler.md)), o
  default seria justamente a base compartilhada - e uma produção mal
  configurada escreveria nela sem reclamar de nada.
- `DB_PASSWORD` - segredo não tem default em hipótese nenhuma.

`NODE_ENV` também não tem default. Ela decide quais jobs o processo registra
([capítulo 05](05-scheduler.md)), e por isso diz **o que** o serviço faz no
banco, como os campos de conexão. Um default `development` parecia uma falha
fechada, mas não era: um pod de produção sem a variável registraria os jobs de
DEV e os dispararia contra o banco de produção, com apenas um `warn` no log.
Sem default, a falta da variável derruba o boot com uma mensagem que diz por
que ela é obrigatória.

Nada perde com isso fora do deploy: o vitest injeta `NODE_ENV=test` em
[`test/setup.ts`](../test/setup.ts), e `npm run dev` lê o `.env`, que já traz
`NODE_ENV=development` no [`.env.example`](../.env.example) - sem `.env`, os
campos de conexão derrubariam o boot de qualquer forma.

Vale registrar o limite do schema: ele valida **presença e forma, nunca
verdade**. `NODE_ENV=production` injetada por engano na homologação é valor
válido do enum e passa calada. Nenhum `refine` resolve isso, porque o processo
não tem como saber onde está - só o que lhe contaram.

### O lugar certo de reduzir repetição

Se o incômodo é manter o mesmo valor em quatro grupos de variáveis da
pipeline, a solução é da pipeline, não do schema: um variable group comum para
o que não muda entre ambientes, mais um por ambiente para o que muda. Isso
reduz a repetição sem enfraquecer a validação - enquanto mover valores de
identidade para o `.default(...)` faria o oposto.

## Upgrades futuros sem quebrar o que existe

**Adicionar uma variável nova** - o caminho de menor risco:

1. Adicione o campo no `esquemaAmbiente`, **com `.default(...)`** se o serviço puder
   funcionar sem ele.
2. Adicione a linha no [`.env.example`](../.env.example), comentada se for opcional.
3. Registre na tabela acima.
4. Só depois peça para a pipeline injetar o valor.

Se a variável for obrigatória (sem default), a ordem se inverte: **primeiro** a
pipeline passa a injetar, **depois** o schema exige. Na ordem contrária, o
próximo deploy não sobe.

**Impactos da troca de `DB_ENCRYPT` e de `NODE_ENV` obrigatória** - as duas
mudanças valem a partir do mesmo deploy. Confira a pipeline de cada ambiente
antes de subir:

| Situação na pipeline | Antes | Agora |
| --- | --- | --- |
| `DB_ENCRYPT=false` ou `0` | TLS **ligado** (o coerce lia `true`) | TLS desligado |
| `DB_ENCRYPT` vazia | TLS desligado | Boot derrubado - remova a variável ou use `true`/`false` |
| `DB_ENCRYPT=TRUE`, `False`, `yes`... | TLS ligado | Boot derrubado - use `true`, `false`, `1` ou `0` |
| `DB_ENCRYPT` ausente, `true` ou `1` | TLS ligado | Sem mudança |
| `NODE_ENV` ausente | Assumia `development`, com `warn` | Boot derrubado - injete o valor no ConfigMap |
| `NODE_ENV` com um dos cinco valores | - | Sem mudança |

O caso que merece atenção é o primeiro: um ambiente que declarava
`DB_ENCRYPT=false` vinha conectando com TLS sem saber, e passa a conectar sem.
Se esse servidor exige TLS, a conexão agora falha no boot; se não exige, o
tráfego deixa de ser cifrado. Nos dois casos, a correção é declarar o valor que
o ambiente de fato precisa.

**Migrar para zod 4** - a API de erros mudou. O ponto de impacto aqui é único:
`resultado.error.flatten().fieldErrors` em `carregarAmbiente()`. Em zod 4 o
equivalente é `z.treeifyError(resultado.error)`. Como todo o uso de zod está
concentrado em `env.ts`, a migração é pequena - mas rode `npm run typecheck`
antes de considerar pronta.

**Trocar por variáveis vindas do Azure Key Vault** - mantenha o `esquemaAmbiente`
como está e resolva os segredos **antes** de importar qualquer coisa de `src/`,
escrevendo-os em `process.env`. A alternativa (tornar `ambiente` assíncrono)
contaminaria todos os módulos que hoje fazem `import { ambiente }` no topo, e
é o tipo de mudança que quebra o sistema inteiro de uma vez.

**Nunca** logue o objeto `ambiente` inteiro. O [logger](03-logger.md) já censura
`DB_PASSWORD`, mas confiar no redact é a segunda linha de defesa, não a
primeira.
