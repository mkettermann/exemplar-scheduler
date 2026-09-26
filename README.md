# Serviço de Agendamentos (Scheduler)

Estrutura base para um serviço isolado de jobs agendados. Roda com **réplica
única fixa** (sem HPA) — o objetivo é justamente não escalar, para os jobs não
rodarem em duplicidade.

## Por que existe

Separado, permite escalar a API horizontalmente sem também multiplicar os jobs.
Este serviço isola essa responsabilidade: um lugar só para inserir job agendado,
com lock distribuído, timeout, log estruturado e health check já resolvidos.

A superfície HTTP é mínima e somente leitura — o **health é o único endpoint**,
e existe porque o Kubernetes precisa de um alvo para as probes. Nenhum job é
disparado por requisição: o cron é a única origem de execução, e o que um job
consome vem de fontes declaradas no próprio código.

## 📚 Documentação

A explicação de **cada peça instalada** — biblioteca escolhida, responsabilidade,
como funciona e como evoluir sem quebrar o que existe — está em
**[`docs/`](docs/README.md)**, que também traz a
[tabela consolidada de bibliotecas](docs/README.md#bibliotecas-instaladas) com
link para a documentação oficial de cada uma.

| # | Capítulo | Cobre |
| --- | --- | --- |
| 01 | [TypeScript e build](docs/01-typescript-e-build.md) | `typescript`, `tsx`, `tsconfig` |
| 02 | [Configuração de ambiente](docs/02-configuracao-de-ambiente.md) | `zod`, `.env` |
| 03 | [Logger](docs/03-logger.md) | `pino`, `pino-pretty` |
| 04 | [Banco de dados](docs/04-banco-de-dados.md) | `mssql`, pool |
| 05 | [Scheduler](docs/05-scheduler.md) | `node-schedule`, contrato de job, entrypoint |
| 06 | [Lock distribuído](docs/06-lock-distribuido.md) | `sp_getapplock` |
| 07 | [Servidor HTTP](docs/07-servidor-http.md) | `fastify`, rotas, guarda somente-leitura |
| 08 | [Health check](docs/08-health-check.md) | liveness, readiness, probes |
| 09 | [Testes](docs/09-testes.md) | `vitest`, `markdownlint-cli2` |
| 10 | [Utilitários](docs/10-utilitarios.md) | `src/util` |
| 11 | [Container e deploy](docs/11-container-e-deploy.md) | `Dockerfile`, Azure |
| 12 | [Exemplo de job e serviço](docs/12-exemplo-job-e-servico.md) | **descartável** |

## Setup local

```bash
npm install
cp .env.example .env   # preencha com os valores do seu ambiente local
npm run dev
```

## Scripts

| Script | O que faz |
| --- | --- |
| `npm run dev` | Roda com watch (tsx) e carrega o `.env`, sem precisar buildar |
| `npm run build` | Compila `src/` para `dist/` |
| `npm start` | Roda o build de produção (`dist/server.js`) |
| `npm run typecheck` | Checa tipos de `src/` **e** de `test/`, sem gerar arquivos |
| `npm test` | Roda a suíte de testes uma vez |
| `npm run test:watch` | Re-roda os testes ao salvar |
| `npm run test:coverage` | Testes + cobertura, com piso de 80% |
| `npm run lint:md` | Verifica a formatação da documentação |

## Endpoints

Somente leitura. Verbos de escrita são recusados com `405` por uma guarda
global, mesmo em caminhos que não existem.

| Método | Rota | Auth | Resposta |
| --- | --- | --- | --- |
| `GET` | `/health` | pública | `200` enquanto o processo está vivo |
| `GET` | `/health/ready` | pública | `200` ou `503` conforme as dependências |

## Estrutura

```text
src/
  server.ts              # entrypoint: liga os sinais e chama iniciar()
  ciclo-de-vida.ts       # boot DB -> jobs -> HTTP, e o encerramento ordenado
  config/env.ts          # variáveis de ambiente validadas (zod)
  logger/logger.ts       # logger estruturado (pino)
  db/mssql.ts            # pool MSSQL compartilhado + verificarSaudeDb
  scheduler/
    job.types.ts         # contrato que todo job segue
    job-runner.ts        # lock + timeout + log, genérico para qualquer job
    lock.ts              # trava via sp_getapplock (evita dupla execução)
  jobs/
    jobs.ts              # lista central de jobs ativos — o boot só importa isto
    example.job.ts       # MODELO — apagar ao implementar
  services/
    example.service.ts   # MODELO — apagar ao implementar
  server/
    app.ts               # monta o Fastify sem subir (usado pelos testes)
    routes.ts            # registro central de todas as rotas
    plugins/read-only.ts # recusa verbos de escrita
    routes/
      health.route.ts    # GET /health e GET /health/ready
  util/util.ts
test/
  setup.ts
  health.route.test.ts
  read-only.guard.test.ts
  jobs-enabled.test.ts
```

## Adicionando um job

1. Crie o serviço em `src/services/` com a regra de negócio.
2. Crie o job em `src/jobs/` — o `executar` só chama o serviço.
3. Adicione ao array em `src/jobs/jobs.ts`.
4. Escreva os testes do serviço e do job, a partir dos modelos `test/example*`.

O entrypoint não precisa ser tocado. Passo a passo completo, incluindo
migração de job legado: [capítulo 12](docs/12-exemplo-job-e-servico.md).

## Banco de dados

O MSSQL é usado apenas pelo [lock distribuído](docs/06-lock-distribuido.md) dos
jobs, via `sp_getapplock`. Não há tabela nem schema a criar antes do primeiro
deploy — o usuário configurado não precisa (e não deve ter) permissão de DDL.

## Variáveis de ambiente

Ver [`.env.example`](.env.example) e a tabela completa no
[capítulo 02](docs/02-configuracao-de-ambiente.md). Em produção, os valores
reais vêm da biblioteca de variáveis do Azure, injetada pela pipeline no
momento do deploy.

Dois interruptores decidem o que roda, e eles respondem perguntas diferentes:

- **`ambientes`**, obrigatório em cada `DefinicaoJob`, declara em quais
  `NODE_ENV` aquele job roda. É o que impede DEV, QA e HML — que costumam
  dividir o mesmo banco — de dispararem o mesmo job duas vezes sobre os mesmos
  dados. O lock distribuído não cobre isso: ele impede a execução simultânea,
  não a sequencial. Ver
  [capítulo 05](docs/05-scheduler.md#um-job-um-ambiente).
- **`JOBS_ENABLED`** decide se este processo registra **algum** job. Ausente,
  vale `true` — o serviço se comporta como antes da variável existir.

Por isso `NODE_ENV` precisa ser explícita e distinta em cada deploy, e o
`Dockerfile` não a fixa: os quatro ambientes rodam a mesma imagem.

## Container e deploy no Azure

O [`Dockerfile`](Dockerfile) é multi-stage: a imagem final carrega `dist/`, as
dependências de produção e nada mais — sem código-fonte, sem `devDependencies`
e sem a suíte de testes.

```bash
docker build -t exemplar-scheduler:local .
docker run --rm -p 3000:3000 --env-file .env exemplar-scheduler:local
```

**O build é um portão**: antes de compilar, o estágio `verify` roda
`npm run typecheck` e `npm run test:coverage`, e qualquer erro — ou cobertura
abaixo de 80% — derruba o `docker build`.

Os quatro estágios, o escape hatch para hotfix, o fuso horário, o `tini` e a
configuração no Container Apps / App Service estão no
[capítulo 11](docs/11-container-e-deploy.md).
