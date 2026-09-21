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
| 05 | [Scheduler](05-scheduler.md) | `node-schedule`, contrato de job, job-runner, entrypoint |
| 06 | [Lock distribuído](06-lock-distribuido.md) | `sp_getapplock`, dupla execução |
| 07 | [Servidor HTTP](07-servidor-http.md) | `fastify`, rotas, guarda somente-leitura |
| 08 | [Health check](08-health-check.md) | liveness, readiness, probes do AKS |
| 09 | [Testes](09-testes.md) | `vitest`, `@vitest/coverage-v8`, `markdownlint-cli2` |
| 10 | [Utilitários](10-utilitarios.md) | `src/util/util.ts` |
| 11 | [Container e deploy](11-container-e-deploy.md) | `Dockerfile`, estágios, Azure |
| 12 | [Exemplo de job e serviço](12-exemplo-job-e-servico.md) | material descartável — **apague ao implementar** |

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
| `markdownlint-cli2` | `^0.23` | [README do projeto](https://github.com/DavidAnson/markdownlint-cli2#readme) | [DavidAnson/markdownlint-cli2](https://github.com/DavidAnson/markdownlint-cli2) | [09](09-testes.md) |
| `@types/node` | `^24` | [Node.js API](https://nodejs.org/docs/latest-v24.x/api/) | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | [01](01-typescript-e-build.md) |
| `@types/mssql` | `^9.1` | — | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | [04](04-banco-de-dados.md) |
| `@types/node-schedule` | `^2.1` | — | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | [05](05-scheduler.md) |

### Sem biblioteca

Quatro peças resolvem seus problemas com recursos já disponíveis, e o capítulo
correspondente explica o porquê:

| Peça | Usa | Cap. |
| --- | --- | --- |
| Lock distribuído | [`sp_getapplock`](https://learn.microsoft.com/sql/relational-databases/system-stored-procedures/sp-getapplock-transact-sql) do SQL Server | [06](06-lock-distribuido.md) |
| Carregamento do `.env` | [`node --env-file`](https://nodejs.org/docs/latest-v24.x/api/cli.html) nativo | [02](02-configuracao-de-ambiente.md) |
| Utilitários de terminal | Códigos ANSI escritos à mão | [10](10-utilitarios.md) |
| Encerramento ordenado | Sinais do Node mais `tini` como PID 1 | [05](05-scheduler.md) |

## Os quatro princípios que explicam o resto

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
sistema é escrita no serviço (ou lida do ambiente validado), não recebida de
fora. Ver [capítulo 12](12-exemplo-job-e-servico.md).

### 3. O job só escreve a regra de negócio

Lock, timeout, medição de duração e captura de erro ficam no
[`job-runner`](../src/scheduler/job-runner.ts). Um job é apenas
`{ nome, agendamento, tempoLimiteMs, executar }`. Isso é o que torna a migração
de um job legado quase um copiar-e-colar da lógica.

### 4. O código é em português, a fronteira não

Variáveis, funções, tipos e propriedades internas são nomeados em português,
sem acentos: `obterPoolDb`, `executarComLock`, `tempoLimiteMs`, `DefinicaoJob`.
A regra vale para tudo que é escrito aqui dentro.

O que **não** é traduzido, porque é contrato com alguém de fora:

| Fica em inglês | Por quê |
| --- | --- |
| Nomes das variáveis de ambiente (`DB_SERVER`, `PORT`) | A pipeline do Azure injeta por esses nomes |
| Corpo das respostas HTTP (`status`, `uptimeSeconds`, `checks`, `latencyMs`) | Lido por probes e por monitoração |
| Parâmetros de `sp_getapplock` (`@Resource`, `@LockMode`) | São da stored procedure do SQL Server |
| Nomes de arquivo (`job-runner.ts`, `health.route.ts`) | Aparecem em links, imports e no histórico do git |
| Termos técnicos sem tradução corrente (`job`, `lock`, `pool`, `timeout`, `cron`) | Traduzir atrapalharia mais do que ajuda |

A tradução acontece na borda: `verificarSaudeDb()` devolve
`{ ok, latenciaMs, erro? }`, e o handler do readiness monta o corpo da resposta
com as chaves em inglês ([capítulo 08](08-health-check.md)).

Comentário no meio do código segue a mesma lógica de fronteira: ele diz **o
quê** e aponta o capítulo que explica **o porquê**. A explicação longa mora
aqui, onde pode ser lida inteira; o código fica com uma linha e um endereço.

## Mapa de arquivos

```text
src/
  server.ts                      # entrypoint: DB -> jobs -> HTTP -> encerramento -> cap. 05
  config/env.ts                  # variáveis de ambiente validadas (zod)          -> cap. 02
  logger/logger.ts               # logger estruturado (pino)                      -> cap. 03
  db/mssql.ts                    # pool MSSQL compartilhado + verificarSaudeDb    -> cap. 04
  scheduler/
    job.types.ts                 # contrato que todo job segue                    -> cap. 05
    job-runner.ts                # lock + timeout + log em volta do handler       -> cap. 05
    lock.ts                      # trava via sp_getapplock                        -> cap. 06
  jobs/
    jobs.ts                      # lista central de jobs ativos                   -> cap. 05
    example.job.ts               # MODELO descartável                             -> cap. 12
  services/
    example.service.ts           # MODELO descartável                             -> cap. 12
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
  read-only.guard.test.ts        # trava de somente-leitura e da superfície       -> cap. 09
Dockerfile                       # build multi-stage com portão de verificação    -> cap. 11
```

## Rotina de upgrade (vale para qualquer capítulo)

Cada capítulo termina com uma seção **"Upgrades futuros sem quebrar o que
existe"** específica daquela peça. Antes de qualquer uma delas, o mesmo ritual:

```bash
npm run typecheck   # tipos de src/ e de test/
npm test            # suíte completa
npm run build       # garante que dist/ ainda compila
npm run lint:md     # formatação da documentação
```

Um upgrade que passa nos quatro e não exigiu editar nenhum arquivo fora da peça
trocada é um upgrade seguro. Se exigiu editar arquivos de outras peças, o
isolamento vazou — vale documentar o porquê aqui antes de seguir.
