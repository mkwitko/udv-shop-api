# udv-shop-api

API da plataforma de lojas e doações dos núcleos. Fastify 5 + Prisma + Zod.

## Rodar local
1. `docker compose -f docker-compose.dev.yml up -d`
2. `cp .env.example .env` e preencha (`pnpm keys:generate` para as chaves JWT)
3. `pnpm install && pnpm db:migrate && pnpm db:seed && pnpm dev`

Swagger: http://localhost:3333/docs

## Seed de desenvolvimento
`pnpm db:seed` — idempotente, recusa rodar com `NODE_ENV=production`. Cria a loja
`nucleo-demo` ativa, 4 produtos (um inativo, um sob encomenda), a campanha
`reforma-do-templo` com sorteio aberto e um pedido + doação pagos. Usuários:
`admin@udv.local` (platform admin), `dono@nucleo.local` (owner), `equipe@nucleo.local`
(staff), `cliente@example.org` — senha `senha-forte-123`.

## Contrato para o front
`pnpm openapi:export` regenera `docs/openapi.json` a partir dos schemas Zod das rotas.
É a fonte do tipo no `udv-shop-web` (openapi-typescript/orval) — rode depois de mexer em
schema de rota e commite o arquivo junto.

## Front em outro domínio
Se o web não compartilhar o registrable domain com a API (ex.: `*.vercel.app` x
`*.fly.dev`), ligue `COOKIE_CROSS_SITE=true`: o cookie de refresh passa a `SameSite=None`
+ `Secure`, obrigatório para o navegador enviá-lo no `fetch` do front. Exige HTTPS dos
dois lados. `WEB_ORIGIN` é a única origem liberada no CORS em produção.

## Testes
`pnpm test` (usa o postgres-test da porta 5434)

Arquitetura: ver `docs/` e spec em `../docs/specs/`.
