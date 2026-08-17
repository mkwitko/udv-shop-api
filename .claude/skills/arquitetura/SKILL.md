---
name: arquitetura
description: Use before creating or modifying any endpoint, service, repository, or worker in udv-shop-api. Defines the vertical-slice layout, service factories, gateways, error handling, and testing rules of this repo.
---

# Arquitetura udv-shop-api

Leia `docs/ARCHITECTURE.md`. Regras inegociáveis:
1. Use-case novo = pasta `src/http/api/<recurso>/<use-case>/` com controller + service + schema + teste.
2. Service é factory `createXService(deps)`; nunca importa fastify, Prisma client ou SDK externo.
3. Controller monta deps (`createXRepository(db)`, `app.gateways.*`) e chama o service. Nunca importa `db` para query direta.
4. Toda rota declara schema Zod completo + `operationId` + `tags` + (`config.public` OU `config.permissions`).
5. Erros: sempre subclasses de `AppError` (`src/shared/errors.ts`).
6. Testes de integração com `app.inject` + `buildFakeGateways()`; nunca `vi.mock` de módulo.
7. Dinheiro em centavos int; datas UTC.
Template canônico: `src/http/api/auth/login/`.
