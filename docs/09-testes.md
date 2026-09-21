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
- a superfície HTTP é só o health — nenhuma rota administrativa existe.

## Arquivos

| Arquivo | Cobre |
| --- | --- |
| [`vitest.config.mts`](../vitest.config.mts) | Configuração do runner |
| [`test/setup.ts`](../test/setup.ts) | Variáveis de ambiente dos testes |
| [`test/health.route.test.ts`](../test/health.route.test.ts) | Liveness e readiness, banco online e offline |
| [`test/read-only.guard.test.ts`](../test/read-only.guard.test.ts) | Verbos de escrita recusados, superfície HTTP mínima |
| [`.markdownlint-cli2.jsonc`](../.markdownlint-cli2.jsonc) | Régua de formatação da documentação |

## Como rodar

```bash
npm test             # roda uma vez (é o que o CI usa)
npm run test:watch   # re-roda ao salvar
npm run test:coverage
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

Três detalhes que costumam tropeçar:

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

## Cobertura

`npm run test:coverage`. `src/server.ts`, `src/jobs/`, `src/services/` e
`src/util/` ficam fora da métrica: são, respectivamente, fiação de boot,
material descartável do template e helpers de console.

Não há limiar mínimo configurado, de propósito: em um template, um limiar alto
transforma a primeira contribuição real em uma briga com a ferramenta. Ver
upgrades.

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

**Testar o `job-runner`** — hoje não coberto, e é o código mais crítico da
estrutura. Mocke `lock.ts` e espie o `logger`, verificando que o campo `status`
sai como `sucesso` no caminho feliz, `falha` quando o handler lança e
`timeout` quando estoura o prazo; e que o handler nem é chamado quando o lock
não é adquirido. Use `vi.useFakeTimers()` para não esperar o timeout de
verdade.

**Adicionar testes de integração com banco real** — mantenha-os **separados**
dos unitários, em `test/integration/**`, com um script próprio
(`vitest run --dir test/integration`). Motivo: `npm test` precisa continuar
rodando sem infraestrutura, ou deixa de ser executado localmente. Um
[Testcontainers](https://node.testcontainers.org/) com a imagem do SQL Server
resolve o provisionamento no CI.

**Definir limiar de cobertura** — quando a estrutura tiver código real, ligue
`coverage.thresholds` no `vitest.config.mts`. Comece pelo valor atual medido,
não por um número redondo aspiracional: a função do limiar é impedir regressão,
não forçar uma meta.

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
`npm test` e `npm run test:coverage`: o provider de cobertura é a parte que
mais muda entre majors.
