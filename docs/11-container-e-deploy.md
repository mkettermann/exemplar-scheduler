# 11 — Container e deploy

[← Utilitários](10-utilitarios.md) ·
[Índice](README.md) ·
[Próximo: Exemplo de job e serviço →](12-exemplo-job-e-servico.md)

## Biblioteca

Nenhuma. O [`Dockerfile`](../Dockerfile) usa a imagem oficial `node:24-alpine`
e dois pacotes do sistema: `tini` e `tzdata`.

## Responsabilidade

Produzir uma imagem que carregue `dist/`, as dependências de produção e nada
mais — sem código-fonte, sem `devDependencies` e sem a suíte de testes. Isso
reduz tanto o tamanho quanto a superfície de CVE que o Defender for Containers
reporta.

```bash
docker build -t exemplar-scheduler:local .
docker run --rm -p 3000:3000 --env-file .env exemplar-scheduler:local
```

## Os quatro estágios

| Estágio | O que faz | O que sobrevive |
| --- | --- | --- |
| `deps` | `npm ci` com as dependências completas | `node_modules` para o estágio seguinte |
| `verify` | `npm run typecheck`, `npm test` e `npm run build` | `dist/` |
| `prod-deps` | `npm ci --omit=dev --ignore-scripts` | `node_modules` de produção |
| `runtime` | Monta a imagem final | É a imagem publicada |

Três decisões merecem nota:

- **Só o manifesto é copiado no `deps`.** Enquanto `package.json` e
  `package-lock.json` não mudarem, o Docker reaproveita a camada e o `npm ci`
  não roda de novo, mesmo com o `src/` inteiro alterado.
- **`npm ci`, não `npm install`.** Instala exatamente o que está no lockfile,
  falha se o `package.json` divergir dele e não reescreve o lock durante o
  build. É o que torna a imagem reprodutível.
- **`prod-deps` é um estágio separado**, e não um `npm prune --omit=dev` sobre
  a árvore completa: o prune deixa resíduo, a instalação limpa a partir do
  lockfile não deixa.

## O build é um portão

O estágio `verify` roda `npm run typecheck` e `npm test` **antes** de compilar.
Qualquer erro de tipo ou teste vermelho derruba o `docker build`, e nenhuma
imagem é produzida.

Para um hotfix em que o portão precise ser contornado, existe uma saída
explícita, que fica registrada no log da pipeline:

```bash
docker build --build-arg SKIP_CHECKS=1 -t exemplar-scheduler:hotfix .
```

Ela **não** deve virar padrão no YAML de deploy. O valor do portão é
justamente não depender de alguém lembrar de rodar os testes.

## Fuso horário

O cron do `node-schedule` usa o fuso do **processo**
([capítulo 05](05-scheduler.md)), e uma imagem Alpine sem `tzdata` resolve
qualquer `TZ` como UTC silenciosamente — `0 3 * * *` dispararia à meia-noite em
Brasília.

Por isso o Dockerfile instala `tzdata` e fixa `TZ=America/Sao_Paulo`. Ajuste
com `--build-arg TZ=...` no build, ou pela variável de ambiente `TZ` no Azure.

## `tini` como PID 1

```dockerfile
ENTRYPOINT ["/sbin/tini", "--"]
```

O `tini` encaminha o `SIGTERM` ao Node e recolhe processos órfãos. Importa aqui
porque o encerramento ordenado de [`server.ts`](../src/server.ts) espera os
jobs em andamento terminarem ([capítulo 05](05-scheduler.md)): um `SIGKILL` no
lugar do `SIGTERM` cortaria um job pela metade, que é exatamente o que o lock
distribuído não consegue desfazer ([capítulo 06](06-lock-distribuido.md)).

## Outras opções da imagem final

- **`USER node`** — usuário sem privilégio já presente na imagem oficial
  (uid 1000). Nada roda como root.
- **`--enable-source-maps`** no `CMD`, porque o `tsconfig` gera sourcemap: sem
  a flag, o stack trace de um job que falha às 3h aponta para a linha do JS
  compilado ([capítulo 01](01-typescript-e-build.md)).
- **`HEALTHCHECK`** vale para `docker run` e `docker compose`. Azure Container
  Apps e App Service usam as próprias probes e ignoram essa instrução — lá o
  caminho é configurado no serviço ([capítulo 08](08-health-check.md)).

## Configuração no Azure

Todas as variáveis de [`.env.example`](../.env.example) precisam estar
definidas ([capítulo 02](02-configuracao-de-ambiente.md)), e mais:

| Onde | Ajuste |
| --- | --- |
| Container Apps | `targetPort: 3000`; **réplicas mín. e máx. = 1** (sem isso os jobs duplicam) |
| App Service for Containers | app setting `WEBSITES_PORT=3000` |
| Probes | liveness em `GET /health`, readiness em `GET /health/ready` |
| Jobs | `JOBS_ENABLED=false` em qualidade e homologação, `true` em produção ([capítulo 05](05-scheduler.md#ligar-e-desligar-os-jobs-por-ambiente)) |
| Segredos | `DB_PASSWORD` via Key Vault ou secret do Container App, nunca como app setting em texto |

A réplica única não é detalhe de capacidade: é a premissa da arquitetura
([índice](README.md#1-réplica-única-e-o-processo-assume-isso)).

## O que fica fora da imagem

O [`.dockerignore`](../.dockerignore) mantém fora do contexto de build o `.env`
e derivados, `node_modules` e `dist` do host (copiá-los quebraria binários
nativos ao ir de Windows para Linux), além de `docs/`, `.git` e arquivos de
editor — que só aumentariam o contexto enviado ao daemon.

## Upgrades futuros sem quebrar o que existe

**Subir a versão base do Node** — mude `ARG NODE_VERSION` e ajuste
`engines.node`, `target` e `lib` junto ([capítulo 01](01-typescript-e-build.md)).
O `verify` roda no mesmo Node da imagem final, então uma incompatibilidade
aparece no build, não em produção.

**Trocar Alpine por Debian slim** — vale quando alguma dependência precisar de
glibc (pacotes nativos compilados costumam ser o motivo). Troque também o
`apk add` por `apt-get install`, e confirme que `tini` e `tzdata` continuam
presentes.

**Publicar a imagem em um registry privado** — nada no Dockerfile muda. O que
muda é a pipeline: autentique no ACR, marque a imagem com o SHA do commit em
vez de `latest` e deixe o deploy referenciar a tag imutável. Tag móvel torna
impossível responder "qual build está no ar".

**Expor a versão no readiness** — passe o SHA como `ARG`/`ENV` no build e leia
do `ambiente` validado ([capítulo 08](08-health-check.md)). Não importe o
`package.json` para isso.

**Rodar o lint de markdown no CI** — `npm run lint:md` roda junto com o
`typecheck` e os testes ([capítulo 09](09-testes.md)). Ele não entra no
`Dockerfile` de propósito: documentação desformatada não é motivo para
bloquear uma imagem de produção.
