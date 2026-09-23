# Imagem do serviço de agendamentos, para deploy em Azure.
# Build multi-stage: o porquê de cada estágio, do portão de verificação, do
# tini e do fuso está em docs/11-container-e-deploy.md

ARG NODE_VERSION=24-alpine

# --------------------------------------------------------------------------
# 1. deps — dependências completas, em camada própria
# --------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

COPY package.json package-lock.json ./

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

# Escape hatch auditável para hotfix. Nunca defina como padrão no YAML de deploy.
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

# O cron usa o fuso do PROCESSO. Sobrescreva com --build-arg ou pela variável
# TZ no Azure — ver docs/11-container-e-deploy.md
ARG TZ=America/Sao_Paulo
ENV TZ=${TZ}

RUN apk add --no-cache tini tzdata \
    && cp /usr/share/zoneinfo/${TZ} /etc/localtime \
    && echo "${TZ}" > /etc/timezone

# NODE_ENV NÃO é fixado aqui de propósito: a mesma imagem sobe em DEV, QA, HML
# e PRD, e é `NODE_ENV` que decide quais jobs cada ambiente registra
# (`DefinicaoJob.ambientes`). Fixá-la faria os quatro se identificarem como
# `production` e dispararem os mesmos jobs sobre o banco compartilhado.
# A pipeline injeta o valor pelo ConfigMap — ver docs/11-container-e-deploy.md
ENV PORT=3000

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=verify    --chown=node:node /app/dist         ./dist
COPY --chown=node:node package.json ./

USER node

EXPOSE 3000

# Probe local. Container Apps e App Service usam as próprias probes e ignoram
# esta instrução — ver docs/08-health-check.md
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]

CMD ["node", "--enable-source-maps", "dist/server.js"]
