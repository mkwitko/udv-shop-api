# syntax=docker/dockerfile:1

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# Compila TypeScript com todas as dependências.
FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
RUN pnpm db:generate && pnpm build

# Só dependências de produção (inclui prisma CLI para o migrate deploy do boot).
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile --prod
COPY prisma ./prisma
# `version` força o download do schema engine agora; sem isso o migrate deploy
# tentaria baixá-lo em runtime, onde o filesystem é só leitura para o usuário node.
RUN pnpm db:generate && node_modules/.bin/prisma version

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
# openssl é exigido pelo engine do Prisma em imagens slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node package.json ./
USER node
EXPOSE 3333
# Migra antes de subir (o deploy é atômico do ponto de vista do schema) e migra com OUTRA
# credencial: o processo que atende requisição não precisa de DDL. Sem MIGRATE_DATABASE_URL
# definida, cai na DATABASE_URL — é o caso do dev e de quem roda a imagem à mão.
CMD ["sh", "-c", "DATABASE_URL=\"${MIGRATE_DATABASE_URL:-$DATABASE_URL}\" node_modules/.bin/prisma migrate deploy && node dist/server.js"]
