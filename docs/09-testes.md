# 09 — Testes

[← Health check](08-health-check.md) ·
[Índice](README.md) ·
[Próximo: Utilitários →](10-utilitarios.md)

## Bibliotecas

| Pacote | Versão | Papel |
| --- | --- | --- |
| [`vitest`](https://vitest.dev/) | `^5.0` | Runner de testes, com suporte nativo a TypeScript |
| [`@vitest/coverage-v8`](https://vitest.dev/guide/coverage.html) | `^5.0` | Relatório de cobertura usando o coverage do próprio V8 |
| [`markdownlint-cli2`](https://github.com/DavidAnson/markdownlint-cli2#readme) | `^0.23` | Verifica a formatação dos arquivos `.md` |

Por que vitest e não jest: ele executa TypeScript sem `ts-jest` nem configuração
de transform, e a API de mock (`vi.mock`, `vi.hoisted`) resolve o caso central
aqui — substituir o módulo do banco — em poucas linhas. O `node:test` nativo
também serviria, mas o mock de módulo nele ainda é desconfortável.

## Responsabilidade

Provar automaticamente as afirmações que o resto da documentação faz. Em
particular:

- o health check existe, responde e **distingue online de offline**;
- o serviço é de fato somente leitura;
- a superfície HTTP é só o health — nenhuma rota administrativa existe;
- o `openapi.yaml` descreve exatamente essa superfície, e as respostas reais;
- a flag que desliga os jobs é lida sem ambiguidade — `false` é `false`.

## Arquivos

| Arquivo | Cobre |
| --- | --- |
| [`vitest.config.mts`](../vitest.config.mts) | Configuração do runner |
| [`test/setup.ts`](../test/setup.ts) | Variáveis de ambiente dos testes |
| [`test/health.route.test.ts`](../test/health.route.test.ts) | Liveness e readiness, banco online e offline |
| [`test/read-only.guard.test.ts`](../test/read-only.guard.test.ts) | Verbos de escrita recusados, superfície HTTP mínima |
| [`test/openapi.contrato.test.ts`](../test/openapi.contrato.test.ts) | `openapi.yaml` descreve as rotas e as respostas reais |
| [`test/jobs-enabled.test.ts`](../test/jobs-enabled.test.ts) | Leitura da flag `JOBS_ENABLED`, incluindo valor inválido |
| [`test/jobs-ambiente.test.ts`](../test/jobs-ambiente.test.ts) | `separarJobsPorAmbiente`: um job, um ambiente |
| [`test/env-texto-obrigatorio.test.ts`](../test/env-texto-obrigatorio.test.ts) | Espaço e quebra de linha nas pontas dos campos de conexão |
| [`test/job-runner.test.ts`](../test/job-runner.test.ts) | Registro, execução sob lock, classificação de falha e timeout, lock preso até o handler terminar |
| [`test/lock-distribuido.test.ts`](../test/lock-distribuido.test.ts) | Commit, rollback, execução pulada e parâmetros do `sp_getapplock` |
| [`test/mssql.test.ts`](../test/mssql.test.ts) | Pool único, memoização da conexão e o ping do readiness |
| [`test/app-insights.test.ts`](../test/app-insights.test.ts) | Instância única, configurações antes do `start()` e `trackTrace` — ver [capítulo 13](13-application-insights.md) |
| [`test/ciclo-de-vida.test.ts`](../test/ciclo-de-vida.test.ts) | Ordem do boot e do encerramento, `JOBS_ENABLED`, jobs de outro ambiente |
| [`test/server.test.ts`](../test/server.test.ts) | Fiação do entrypoint: sinais e falha fatal no boot |
| [`test/logger.test.ts`](../test/logger.test.ts) | Nível, formato e redação de segredos por ambiente |
| [`test/util.test.ts`](../test/util.test.ts) | Helpers de cor e de objeto, inclusive a mutação herdada do legado |
| [`test/jobs-lista.test.ts`](../test/jobs-lista.test.ts) | Regras que valem para todo job da lista central: nome único, prazo e agendamento |
| [`test/example.job.test.ts`](../test/example.job.test.ts) | MODELO de teste de job — apagar junto com o exemplo |
| [`test/example.service.test.ts`](../test/example.service.test.ts) | MODELO de teste de serviço — apagar junto com o exemplo |
| [`test/example-consulta.service.test.ts`](../test/example-consulta.service.test.ts) | MODELO de teste de serviço com consulta ao banco — apagar junto com o exemplo |
| [`.markdownlint-cli2.jsonc`](../.markdownlint-cli2.jsonc) | Régua de formatação da documentação |

## Como rodar

```bash
npm test             # roda uma vez
npm run test:watch   # re-roda ao salvar
npm run test:coverage # testes + relatório lcov
npm run typecheck    # tipos de src/ E de test/
npm run lint:md      # formatação da documentação
```

Nenhum teste precisa de banco, rede ou porta livre.

## As três peças que fazem isso funcionar

### 1. `setupFiles` preenche o ambiente antes de tudo

```ts
// vitest.config.mts
setupFiles: ['./test/setup.ts'],
```

[`src/config/env.ts`](../src/config/env.ts) valida `process.env` **no momento
do import** e chama `process.exit(1)` se faltar algo ([capítulo
02](02-configuracao-de-ambiente.md)). Em teste isso mataria o worker do vitest
sem mensagem clara. `setupFiles` roda antes dos imports de cada arquivo de
teste, então as variáveis já estão lá.

É também por isso que `NODE_ENV: 'test'` existe no `esquemaAmbiente`: o vitest define
`NODE_ENV=test` sozinho, e sem esse valor no enum a validação reprovaria. O
[logger](03-logger.md) usa o mesmo valor para ficar silencioso.

### 2. `construirApp()` dispensa servidor de verdade

```ts
const app = await construirApp();
await app.ready();

const resposta = await app.inject({ method: 'GET', url: '/health' });
```

`app.inject()` percorre todo o pipeline do Fastify — hooks, `preHandler`,
serialização — sem abrir socket. Os testes rodam em centenas de milissegundos e
não competem por porta quando o CI executa vários jobs em paralelo.

### 3. O banco é mockado, e é isso que permite testar "offline"

```ts
const mocks = vi.hoisted(() => ({ verificarSaudeDb: vi.fn() }));

vi.mock('../src/db/mssql.js', () => ({
  verificarSaudeDb: mocks.verificarSaudeDb,
  obterPoolDb: vi.fn(),
  fecharPoolDb: vi.fn(),
  sql: {},
}));
```

Quatro detalhes que costumam tropeçar:

- **O caminho do `vi.mock` leva `.js`**, igual a qualquer import do projeto
  ([capítulo 01](01-typescript-e-build.md)). O vitest resolve esse caminho até
  o `.ts` real, como faz com os imports — mas os dois precisam apontar para o
  mesmo módulo, senão o mock simplesmente não é aplicado e o teste tenta abrir
  conexão de verdade.
- **`vi.hoisted`** — o vitest iça as chamadas de `vi.mock` para antes dos
  imports. Uma `const` declarada normalmente ainda não existe quando a fábrica
  roda, e o teste falha com "Cannot access before initialization".
  `vi.hoisted` é içado junto.
- **A fábrica precisa exportar tudo** que qualquer módulo da árvore importa
  daquele arquivo — não só o que o teste usa. Hoje só `verificarSaudeDb` é
  chamado, mas `obterPoolDb`, `fecharPoolDb` e `sql` estão na fábrica porque
  são o contrato público do módulo: quando um job novo importar `obterPoolDb`,
  o mock já cobre.
- **O que é chamado com `new` precisa ser `class`** — a partir do vitest 5,
  `vi.fn().mockReturnValue(...)` invocado como construtor lança
  "Cannot use `mockReturnValue` when called with `new`". É por isso que
  [`test/lock-distribuido.test.ts`](../test/lock-distribuido.test.ts) declara
  `sql.Transaction` e `sql.Request` como classes que devolvem o objeto falso
  no construtor, com um `vi.fn()` à parte só para registrar o argumento
  recebido.

Com `verificarSaudeDb` mockado, "banco offline" vira uma linha:

```ts
mocks.verificarSaudeDb.mockResolvedValue({ ok: false, latenciaMs: 3000, erro: '...' });
```

Determinístico, instantâneo e sem precisar derrubar nada de verdade.

## O que os testes garantem hoje

| Asserção | Por que importa |
| --- | --- |
| `/health` responde `200` com `uptimeSeconds` numérico | O contrato da probe de liveness |
| `/health` não exige autenticação | O kubelet não tem como enviar credencial |
| `/health` continua `200` com o banco fora, **sem consultar o banco** | Impede a regressão que causaria `CrashLoopBackOff` |
| `/health` responde a `HEAD` | Algumas probes e balanceadores usam `HEAD` |
| `/health/ready` → `200`/`ok` com o banco online | Readiness positivo |
| `/health/ready` → `503`/`degraded` com o banco offline | Readiness negativo |
| O motivo da falha aparece fora de produção | Diagnóstico |
| A rota não cai se o check lançar | Defesa contra quebra de contrato futura |
| online → offline → online | O estado é reavaliado, não cacheado |
| `POST`/`PUT`/`PATCH`/`DELETE` → `405` | A arquitetura somente-leitura |
| Escrita em caminho inexistente → `405` | A guarda age antes do roteamento |
| Só `/health` e `/health/ready` estão registradas | A superfície HTTP não cresce sem querer |
| Qualquer outra rota → `404` | Idem |
| O job é registrado com o nome e o cron declarados | O agendamento é o que o código diz |
| O handler roda sob lock, com o nome do job como chave | Duas instâncias não executam junto |
| O handler nem é chamado quando o lock é negado | A execução é pulada, não enfileirada |
| Erro do handler vira `(falha)` e não é relançado | Um job quebrado não derruba o processo |
| O erro do handler vai para o log como `err` | Sem ele, a linha diz que falhou, mas não por quê |
| Estouro de prazo vira `(timeout)` | Distinguir "quebrou" de "demorou" muda o diagnóstico |
| Timeout de query do driver vira `(falha)`, não `(timeout)` | A mensagem do `mssql` também começa com `Timeout` |
| Depois do timeout, o lock só sai quando o handler termina | Senão o disparo seguinte roda em paralelo |
| Rollback que falha não esconde o erro original | O runner classifica o erro certo |
| Uma falha não impede a ocorrência seguinte | O scheduler não fica travado |
| Falha do próprio lock vira `logger.fatal` | Alerta de infraestrutura, não de job |
| O temporizador é liberado quando o handler termina antes | Um job rápido não segura o event loop |
| Lock concedido → commit; negado ou erro → rollback | Nenhuma transação fica aberta |
| `LockTimeout` é `0` e o recurso é `job:<nome>` | É o que faz o lock pular em vez de esperar |
| `recordset` vazio é tratado como lock negado | Falta de resposta não pode virar execução |
| Dois jobs no boot esperam a mesma conexão | O pool é um só, e a promise é memoizada |
| Falha de conexão libera a memoização | Senão o processo nunca mais tentaria conectar |
| `fecharPoolDb` sem pool aberto não quebra | O shutdown não depende de ter conectado |
| Erro emitido pelo pool é logado, não propagado | Queda de conexão não derruba o processo |
| `verificarSaudeDb` devolve o erro no corpo, nunca lança | É o contrato de que a rota de readiness depende |
| O ping é `SELECT 1 AS ok` | O readiness não pode custar uma consulta de negócio |
| O prazo padrão é o `HEALTH_DB_TIMEOUT_MS` do ambiente | Banco lento não pode segurar a probe |
| O temporizador é liberado quando o banco responde | Cada check limpa o que criou |
| O Application Insights é configurado uma vez, antes do `start()` | A configuração fica num lugar só, e o SDK não admite dois `setup()` |
| `trackTrace` sem severidade envia `Information` e nunca lança | Telemetria não derruba job |
| Boot: banco, jobs e HTTP, nessa ordem; sem banco, nada sobe | Falha rápido, em vez de no primeiro cron |
| Encerramento: jobs, HTTP, banco e telemetria, nessa ordem | Um job não é cortado com o pool fechado |
| Dois sinais seguidos encerram uma vez só | O procedimento não roda em dobro |
| `SIGTERM` e `SIGINT` são ligados antes do boot | Um sinal durante o boot ainda encerra |
| Nenhum job da lista central repete nome | O nome é a chave do lock |

## Formatação da documentação

`npm run lint:md` roda o `markdownlint-cli2` sobre todo `.md` do repositório.
A régua está em [`.markdownlint-cli2.jsonc`](../.markdownlint-cli2.jsonc) e é o
conjunto padrão do markdownlint, com duas exceções declaradas:

| Regra | Ajuste | Por quê |
| --- | --- | --- |
| `MD013` (comprimento da linha) | 80 colunas, ignorando tabelas, blocos de código e títulos | Quebrar a linha de uma tabela muda a renderização; quebrar um bloco de código muda o comando |
| `MD024` (títulos duplicados) | `siblings_only` | "Bibliotecas", "Responsabilidade" e "Upgrades futuros..." se repetem de propósito em cada capítulo |

Tudo o mais fica no padrão — inclusive `MD031`, que exige linha em branco em
volta de todo bloco de código, e `MD032`, que exige o mesmo para listas.

O lint não entra no `Dockerfile` de propósito
([capítulo 11](11-container-e-deploy.md)): documentação desformatada não é
motivo para bloquear uma imagem de produção. No CI, ele roda junto com o
`typecheck`.

## Upgrades futuros sem quebrar o que existe

**Testar um serviço novo** — é o teste de maior retorno, porque serviço é onde
mora a regra de negócio. Como serviços não dependem de Fastify, o teste é
direto: importe a função, mocke o repositório, verifique o resultado. Foi para
isso que a lógica saiu do `handler` ([capítulo 12](12-exemplo-job-e-servico.md)).

**Passar o desfecho do job para campos próprios** — a linha de falha já leva
`{ job, status, err }` como objeto; a de sucesso ainda tem `status` e duração
só dentro do texto, e
[`test/job-runner.test.ts`](../test/job-runner.test.ts) os verifica por
`stringMatching`. Se um dia a consulta no Log Analytics precisar de campo
consultável, troque a interpolação por `logger.info({ job, status, duracaoMs
}, 'Job concluido')` — e as asserções, por `objectContaining`. As duas coisas
mudam juntas, e só elas.

**Adicionar testes de integração com banco real** — mantenha-os **separados**
dos unitários, em `test/integration/**`, com um script próprio
(`vitest run --dir test/integration`). Motivo: `npm test` precisa continuar
rodando sem infraestrutura, ou deixa de ser executado localmente. Um
[Testcontainers](https://node.testcontainers.org/) com a imagem do SQL Server
resolve o provisionamento no CI.

**Rodar no CI** — o mínimo útil, em ordem:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run lint:md
```

`typecheck` antes de `test` porque o vitest transpila sem checar tipos: um erro
de tipo passaria pelos testes e só apareceria no `build`.

**Subir a major do vitest** — as quebras costumam estar na configuração, não
nos testes. Como a configuração é curta, o conserto é local. Rode
`npm test` e `npm run typecheck`.
