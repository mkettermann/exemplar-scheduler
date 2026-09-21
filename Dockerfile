# Imagem do serviço de agendamentos, para deploy em Azure
# (Container Apps, App Service for Containers ou AKS).
#
# Build multi-stage: as dependências de desenvolvimento, o código-fonte e a
# suíte de testes existem apenas nos estágios intermediários. A imagem final
# carrega `dist/`, as dependências de produção e nada mais — o que reduz tanto
# o tamanho quanto a superfície de CVE que o Defender for Containers reporta.

ARG NODE_VERSION=24-alpine

# --------------------------------------------------------------------------
# 1. deps — dependências completas, em camada própria
# --------------------------------------------------------------------------
# Só o manifesto é copiado aqui. Enquanto package.json e package-lock.json não
# mudarem, o Docker reaproveita esta camada e o `npm ci` não roda de novo,
# mesmo com o src/ inteiro alterado.
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

COPY package.json package-lock.json ./

# `npm ci` e não `npm install`: instala exatamente o que está no lockfile,
# falha se o package.json divergir dele e não reescreve o lock durante o
# build. É o que torna a imagem reprodutível.
RUN npm ci

# --------------------------------------------------------------------------
# 2. verify — typecheck + testes + compilação
# --------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS verify
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.test.json vitest.config.mts ./
COPY src ./src
COPY test ./test

# Escape hatch auditável para hotfix. O padrão é verificar; quem pula precisa
# passar --build-arg SKIP_CHECKS=1 explicitamente, e isso fica registrado no
# log da pipeline. Nunca defina isso como padrão no YAML do deploy.
ARG SKIP_CHECKS=0

RUN set -e; \
    if [ "$SKIP_CHECKS" = "1" ]; then \
      echo '>> AVISO: typecheck e testes PULADOS (SKIP_CHECKS=1)'; \
      npm run build \
        || echo '>> AVISO: build emitiu JS apesar de erros de tipo'; \
    else \
      npm run typecheck; \
      npm test; \
      npm run build; \
    fi; \
    test -f dist/server.js

# --------------------------------------------------------------------------
# 3. prod-deps — só o que roda em produção
# --------------------------------------------------------------------------
# Estágio separado porque `npm prune --omit=dev` sobre a árvore completa deixa
# resíduo; uma instalação limpa a partir do lockfile não deixa.
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# --------------------------------------------------------------------------
# 4. runtime — imagem final
# --------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

# O cron do node-schedule usa o fuso do PROCESSO. Alpine sem tzdata resolve
# qualquer TZ como UTC silenciosamente, e `0 3 * * *` dispararia meia-noite em
# Brasília. Sobrescreva com --build-arg ou pela variável TZ no Azure.
ARG TZ=America/Sao_Paulo
ENV TZ=${TZ}

# tini como PID 1: encaminha SIGTERM ao Node e recolhe processos órfãos.
# Importante aqui porque o shutdown ordenado de `src/server.ts` espera os jobs
# em andamento terminarem — um SIGKILL no lugar do SIGTERM cortaria um job pela
# metade, que é exatamente o que o lock distribuído não consegue desfazer.
RUN apk add --no-cache tini tzdata \
    && cp /usr/share/zoneinfo/${TZ} /etc/localtime \
    && echo "${TZ}" > /etc/timezone

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=verify    --chown=node:node /app/dist         ./dist
COPY --chown=node:node package.json ./

# Usuário sem privilégio já presente na imagem oficial (uid 1000).
USER node

EXPOSE 3000

# Probe local (docker run / docker compose). Azure Container Apps e App Service
# usam as próprias probes e ignoram esta instrução — configure lá o mesmo
# caminho: liveness em /health, readiness em /health/ready.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]

# `--enable-source-maps` porque o tsconfig gera sourcemap: sem a flag, o stack
# trace de um job que falha às 3h aponta para a linha do JS compilado.
CMD ["node", "--enable-source-maps", "dist/server.js"]
