# Serviço de Agendamentos (Scheduler)

Serviço isolado de jobs agendados. Roda com **réplica única fixa** (sem HPA) — o objetivo é justamente não escalar, para os jobs não rodarem em duplicidade.

## Por que existe

Separado, permite escalar a API horizontalmente sem também multiplicar os jobs. Este serviço separa essa responsabilidade.

## Setup local

```bash
npm install
cp .env.example .env   # preencha com os valores do seu ambiente local
npm run dev
```

## Scripts

- `npm run dev` — roda com watch (tsx), sem precisar buildar.
- `npm run build` — compila `src/` para `dist/`.
- `npm start` — roda o build de produção (`dist/index.js`).
- `npm run typecheck` — só checa tipos, sem gerar arquivos.

## Estrutura

```text
src/
  server.ts              # entrypoint único: conecta DB, registra jobs, sobe Fastify (https://fastify.dev/docs/latest/)
  config/env.ts          # variáveis de ambiente validadas (zod) (https://zod.dev/)
  db/mssql.ts            # pool de conexão MSSQL compartilhado
  jobs/                  # um arquivo por job (ver example.job.ts como modelo)
    jobs.ts              # lista central de jobs ativos — server.ts só importa isto
  logger/logger.ts       # logger estruturado (pino) (https://getpino.io/#/docs/api)
  repository/
    execution-log.repository.ts  # histórico de execuções (tabela job_executions)
  scheduler/
    job.types.ts         # contrato que todo job deve seguir
    job-runner.ts        # lock + log + timeout, genérico para qualquer job
    lock.ts              # trava via sp_getapplock (evita dupla execução)
  server/routes.ts       # registro central de todas as rotas
  server/routes/
    health.route.ts      # GET /health (sem auth — usado pelas probes do AKS)
    executions.route.ts  # GET /admin/executions (protegido por ADMIN_API_KEY)
```

## Adicionando um job migrado do repositório legado

1. Copie `src/scheduler/jobs/example.job.ts` com o nome do job real.
2. Cole a lógica de negócio dentro de `handler`, tipando o que antes não tinha tipo.
3. Ajuste `schedule` (cron) e `timeoutMs` (jobs pesados precisam de timeout maior).
4. Rode em modo dry-run (só logar, sem efeito real) por um tempo antes de desativar
   o job correspondente no repositório legado.
5. Adicione o job ao array `jobs` em `src/index.ts`.

## Banco de dados

Antes do primeiro deploy, criar a tabela de controle de execuções (DDL de referência
comentado em `src/repository/execution-log.repository.ts`).

## Variáveis de ambiente

Ver `.env.example`. Em produção, os valores reais vêm da biblioteca de variáveis do
Azure já usada pelo time, injetada pela pipeline no momento do deploy.
