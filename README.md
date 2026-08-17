# udv-shop-api

API da plataforma de lojas e doações dos núcleos. Fastify 5 + Prisma + Zod.

## Rodar local
1. `docker compose -f docker-compose.dev.yml up -d`
2. `cp .env.example .env` e preencha (`pnpm keys:generate` para as chaves JWT)
3. `pnpm install && pnpm db:migrate && pnpm dev`

Swagger: http://localhost:3333/docs

## Testes
`pnpm test` (usa o postgres-test da porta 5434)

Arquitetura: ver `docs/` e spec em `../docs/specs/`.
