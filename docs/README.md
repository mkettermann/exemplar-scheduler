# Documentação técnica — Exemplar Scheduler

Esta pasta descreve **cada peça instalada** nesta estrutura: qual biblioteca foi
escolhida, qual é a responsabilidade dela, como ela se conecta ao resto e — no
final de cada capítulo — **como evoluir aquela peça sem quebrar o que já existe**.

A estrutura é um ponto de partida para um sistema novo. Leia na ordem se for a
primeira vez; depois use como referência pontual.

## Índice

| # | Capítulo | Cobre |
| --- | --- | --- |
| 01 | [TypeScript e build](01-typescript-e-build.md) | `typescript`, `tsx`, `tsconfig.json`, `dist/` |
| 02 | [Configuração de ambiente](02-configuracao-de-ambiente.md) | `zod`, `src/config/env.ts`, `.env` |
| 03 | [Logger](03-logger.md) | `pino`, `pino-pretty`, `src/logger/` |
| 04 | [Banco de dados](04-banco-de-dados.md) | `mssql`, pool, health check |
| 05 | [Scheduler](05-scheduler.md) | `node-schedule`, contrato de job, job-runner |
| 06 | [Lock distribuído](06-lock-distribuido.md) | `sp_getapplock`, dupla execução |
| 07 | [Servidor HTTP](07-servidor-http.md) | `fastify`, rotas, guarda somente-leitura |
| 08 | [Health check](08-health-check.md) | liveness, readiness, probes do AKS |
| 09 | [Testes](09-testes.md) | `vitest`, `@vitest/coverage-v8` |
| 10 | [Utilitários](10-utilitarios.md) | `src/util/util.ts` |
| 11 | [Exemplo de job e serviço](11-exemplo-job-e-servico.md) | material descartável — **apague ao implementar** |

## Bibliotecas instaladas

Tabela consolidada para consulta rápida. Cada capítulo explica **por que** a
biblioteca foi escolhida e como ela é usada aqui; os links abaixo levam à
documentação oficial, para quando o assunto precisar ir além do que esta pasta
cobre.

### Produção

| Pacote | Versão | Documentação oficial | Repositório | Cap. |
| --- | --- | --- | --- | --- |
| `fastify` | `^5.1` | [fastify.dev/docs/latest](https://fastify.dev/docs/latest/) | [fastify/fastify](https://github.com/fastify/fastify) | [07](07-servidor-http.md) |
| `mssql` | `^11.0` | [tediousjs.github.io/node-mssql](https://tediousjs.github.io/node-mssql/) | [tediousjs/node-mssql](https://github.com/tediousjs/node-mssql) | [04](04-banco-de-dados.md) |
| `node-schedule` | `^2.1` | [README do projeto](https://github.com/node-schedule/node-schedule#readme) | [node-schedule/node-schedule](https://github.com/node-schedule/node-schedule) | [05](05-scheduler.md) |
| `pino` | `^9.5` | [getpino.io/#/docs/api](https://getpino.io/#/docs/api) | [pinojs/pino](https://github.com/pinojs/pino) | [03](03-logger.md) |
| `pino-pretty` | `^13` | [README do projeto](https://github.com/pinojs/pino-pretty#readme) | [pinojs/pino-pretty](https://github.com/pinojs/pino-pretty) | [03](03-logger.md) |
| `zod` | `^3.23` | [zod.dev](https://zod.dev/) | [colinhacks/zod](https://github.com/colinhacks/zod) | [02](02-configuracao-de-ambiente.md) |

### Desenvolvimento

| Pacote | Versão | Documentação oficial | Repositório | Cap. |
| --- | --- | --- | --- | --- |
| `typescript` | `^5.7` | [typescriptlang.org/docs](https://www.typescriptlang.org/docs/) | [microsoft/TypeScript](https://github.com/microsoft/TypeScript) | [01](01-typescript-e-build.md) |
| `tsx` | `^4.19` | [tsx.is](https://tsx.is/) | [privatenumber/tsx](https://github.com/privatenumber/tsx) | [01](01-typescript-e-build.md) |
| `vitest` | `^5.0` | [vitest.dev](https://vitest.dev/) | [vitest-dev/vitest](https://github.com/vitest-dev/vitest) | [09](09-testes.md) |
| `@vitest/coverage-v8` | `^5.0` | [vitest.dev/guide/coverage](https://vitest.dev/guide/coverage.html) | [vitest-dev/vitest](https://github.com/vitest-dev/vitest) | [09](09-testes.md) |
| `@types/node` | `^24` | [Node.js API](https://nodejs.org/docs/latest-v24.x/api/) | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | [01](01-typescript-e-build.md) |
| `@types/mssql` | `^9.1` | — | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | [04](04-banco-de-dados.md) |
| `@types/node-schedule` | `^2.1` | — | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | [05](05-scheduler.md) |

### Sem biblioteca

Três peças resolvem seus problemas com recursos já disponíveis, e o capítulo
correspondente explica o porquê:

| Peça | Usa | Cap. |
| --- | --- | --- |
| Lock distribuído | [`sp_getapplock`](https://learn.microsoft.com/sql/relational-databases/system-stored-procedures/sp-getapplock-transact-sql) do SQL Server | [06](06-lock-distribuido.md) |
| Carregamento do `.env` | [`node --env-file`](https://nodejs.org/docs/latest-v24.x/api/cli.html) nativo | [02](02-configuracao-de-ambiente.md) |
| Utilitários de terminal | Códigos ANSI escritos à mão | [10](10-utilitarios.md) |

## Os três princípios que explicam o resto

### 1. Réplica única, e o processo assume isso

O serviço roda com **uma réplica fixa**, sem HPA. Isso não é limitação: é o
objetivo. Se duas instâncias rodassem o mesmo cron, todo job precisaria ser
idempotente — e jobs migrados de sistemas legados quase nunca são.

Mesmo assim existe o [lock distribuído](06-lock-distribuido.md): durante um
rolling update o pod antigo e o novo convivem por alguns segundos, e essa
janela é suficiente para uma execução duplicada.

### 2. A superfície HTTP é somente leitura, e é mínima

O único endpoint do serviço é o **health**, em duas variantes
([capítulo 08](08-health-check.md)). Ele existe porque o Kubernetes precisa de
um alvo para as probes — não porque o serviço tenha uma API.

- Não há rota `POST`/`PUT`/`PATCH`/`DELETE`, e uma guarda global
  ([`read-only.ts`](../src/server/plugins/read-only.ts)) devolve `405` para
  esses verbos mesmo que alguém registre uma rota de escrita por engano.
- Nenhum job é disparado por requisição. O cron é a única origem de execução.
- O que um job consome vem de **fontes declaradas no código** — constantes,
  variáveis de ambiente validadas, consultas escritas no próprio serviço —
  nunca do corpo ou da query de uma requisição.

Consequência prática: para um job consultar um sistema externo, a URL desse
sistema é escrita no serviço (ou lida do env validado), não recebida de fora.
Ver [capítulo 11](11-exemplo-job-e-servico.md).

### 3. O job só escreve a regra de negócio

Lock, timeout, medição de duração e captura de erro ficam no
[`job-runner`](../src/scheduler/job-runner.ts). Um job é apenas
`{ name, schedule, timeoutMs, handler }`. Isso é o que torna a migração de um
job legado quase um copiar-e-colar da lógica.

## Mapa de arquivos

```text
src/
  server.ts                      # entrypoint: DB -> jobs -> HTTP -> shutdown ordenado
  config/env.ts                  # variáveis de ambiente validadas (zod)          -> cap. 02
  logger/logger.ts               # logger estruturado (pino)                      -> cap. 03
  db/mssql.ts                    # pool MSSQL compartilhado + checkDbHealth       -> cap. 04
  scheduler/
    job.types.ts                 # contrato que todo job segue                    -> cap. 05
    job-runner.ts                # lock + timeout + log em volta do handler       -> cap. 05
    lock.ts                      # trava via sp_getapplock                        -> cap. 06
  jobs/
    jobs.ts                      # lista central de jobs ativos                   -> cap. 05
    example.job.ts               # MODELO descartável                             -> cap. 11
  services/
    example.service.ts           # MODELO descartável                             -> cap. 11
  server/
    app.ts                       # monta o Fastify sem subir (testável)           -> cap. 07
    routes.ts                    # mapa explícito de rotas                        -> cap. 07
    plugins/read-only.ts         # guarda de verbos de escrita                    -> cap. 07
    routes/
      health.route.ts            # GET /health e GET /health/ready                -> cap. 08
  util/util.ts                   # helpers de console e objeto                    -> cap. 10
test/
  setup.ts                       # env dos testes                                 -> cap. 09
  health.route.test.ts           # health online/offline                          -> cap. 09
  read-only.guard.test.ts        # trava de somente-leitura e da superfície        -> cap. 09
```

## Rotina de upgrade (vale para qualquer capítulo)

Cada capítulo termina com uma seção **"Upgrades futuros sem quebrar o que
existe"** específica daquela peça. Antes de qualquer uma delas, o mesmo ritual:

```bash
npm run typecheck   # tipos de src/ e de test/
npm test            # suíte completa
npm run build       # garante que dist/ ainda compila
```

Um upgrade que passa nos três e não exigiu editar nenhum arquivo fora da peça
trocada é um upgrade seguro. Se exigiu editar arquivos de outras peças, o
isolamento vazou — vale documentar o porquê aqui antes de seguir.
