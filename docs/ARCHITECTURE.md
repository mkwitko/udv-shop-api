# Arquitetura — udv-shop-api

Este documento descreve como o código deste repositório é organizado e por quê.
É o ponto de partida para quem for adicionar um endpoint, worker ou integração
nova. O template canônico, com todos os padrões abaixo aplicados de forma
completa, é `src/http/api/auth/login/` — na dúvida, copie de lá.

## Stack

Fastify 5 + Prisma 6 + Zod 4, ESM puro (sempre `.js` nos imports relativos,
mesmo apontando para `.ts`). Validação e serialização via
`fastify-type-provider-zod`. Documentação OpenAPI gerada pelo `@fastify/swagger`
e consumida pelo Kubb no frontend para gerar o client tipado — por isso todo
schema e `operationId` importam de verdade (ver ADR-002 em `DECISIONS.md`).

## Anatomia de um use-case (vertical slice)

Cada caso de uso vive em `src/http/api/<recurso>/<use-case>/`, com até quatro
arquivos:

- `<use-case>.controller.ts` — registra a rota Fastify. Monta as dependências
  concretas (repository com `db` real, `app.gateways.*`) e chama o service.
  Nunca contém regra de negócio.
- `<use-case>.service.ts` — factory `createXService(deps)` que devolve a
  função de execução do caso de uso. **Nunca importa `fastify`, o client do
  Prisma ou qualquer SDK de terceiro** — só tipos e as interfaces de
  repository/gateway injetadas. Isso é o que permite testar o service isolado
  e trocar a implementação (ex.: fake gateway) sem tocar a lógica.
  Ver `src/http/api/auth/login/login.service.ts` como referência mínima e
  `src/http/api/auth/google/google.service.ts` para um caso com upsert/link.
- `<use-case>.schema.ts` — schemas Zod de entrada/saída, reexportados quando
  compartilhados entre rotas (ex.: `AuthResponse` e `PublicUserSchema`
  nascem em `register/register.schema.ts` e são reaproveitados por login,
  refresh e `/auth/me`).
- teste em `test/e2e/<slice>.test.ts` — sobe a app inteira via `buildApp()` e
  bate com `app.inject`.

Toda rota **declara** (nunca por omissão):

1. Schema Zod completo (`body`/`querystring`/`response`) — vira contrato
   OpenAPI.
2. `operationId` único e `tags` — é o nome do método gerado pelo Kubb.
3. `config.public: true` (rota sem autenticação) **ou** `config.permissions`
   (`{ any: [...] }` / `{ all: [...] }` com personas — ver seção Hooks).
   Uma rota autenticada sem nenhuma das duas opções falha em runtime com
   `AUTH_NO_PERMISSIONS` (ver `permissionsHook`) — isso é intencional: não dá
   pra esquecer de decidir o nível de acesso.

## Repository por agregado

`src/http/api/auth/auth.repository.ts` define uma interface (`AuthRepository`)
e uma factory `createAuthRepository(db: PrismaClient)` que a implementa com
queries Prisma. Controllers nunca importam `db` para fazer query direta —
sempre passam pelo repository. Isso mantém o Prisma isolado numa camada fina e
faz o service depender só da interface, não da implementação.

Padrão de nomenclatura do banco: PK `uuid` (`@db.Uuid`), colunas em
`snake_case` via `@map`, dinheiro em centavos (inteiro), datas em UTC
(`DateTime` do Prisma sem timezone customizado).

## Paginação por cursor

Todas as rotas de listagem usam paginação por cursor (nunca `offset/limit`)
para evitar dados inconsistentes quando registros são inseridos/deletados
durante navegação. O cursor é opaco (id + campo de ordenação codificados em
base64url), validado e decodificado no repository.

Regras:
- Ordenação canônica: `createdAt DESC, id DESC` (estável mesmo com INSERTs
  concorrentes).
- Request inclui `limit + 1` na query Prisma; devolve `limit` registros +
  flag `hasMore` (verdadeiro se houve mais de `limit` resultados).
- Cursor vem em `querystring.cursor` (ou não, na primeira página).
- Helpers em `src/lib/cursor.ts`: `encodeCursor()`, `decodeCursor()`.
- Exemplo canônico: `stores.repository.listActiveByCursor(limit, cursor)`.

## Autorização por loja

Rotas protegidas por função dentro de uma loja usam `requireStoreRole`, que
valida hierarquia: `staff < admin < owner` (cada nível herda permissões da
anterior). `platform_admin` ignora a hierarquia (bypass total).

Padrão do controller:
1. Resolve a loja por slug (via repository, ex.: `getStoreBySlug()`).
2. Chama `requireStoreRole(req.user, storeId, minimumRole)` — lança
   `ForbiddenError` se o usuário não tiver o nível exigido.
3. Passa para o service/repository.

Staleness de roles no JWT:
- Access token TTL é 15 minutos (`ACCESS_TOKEN_TTL_S`).
- Após o usuário criar uma loja ou mudar de papel, o frontend chama
  `/auth/refresh` para obter um novo token com as roles atualizadas
  (sem aguardar expiração).

## Rotas públicas com identidade opcional

Algumas rotas (ex.: catálogo de produtos) são públicas mas ganham funcionalidades
extras se o usuário estiver autenticado (ex.: mostrar preço especial, favoritos).

`optionalUser` (`src/http/hooks/optional-user.ts`) é um `preHandler` que:
- Tenta validar o JWT de `Authorization: Bearer`.
- Se tiver token válido: `req.user` é populado (como em `authHook`).
- Se não tiver ou for inválido: `req.user` é `undefined`, sem erro — prossegue.
- Rotas com `config.public: true` usam essa hook para acesso condicional a
  roles (ex.: `getStoreProducts()` filtra por permissão se autenticado).

## Gateways (integrações externas) e fakes

Toda dependência externa de rede (email transacional, OAuth de terceiros,
cloud storage) é um gateway: uma interface + uma implementação real,
registradas no plugin `src/http/plugins/gateways-plugin.ts` e expostas em
`app.gateways`.
`buildApp({ gateways })` aceita um override completo — é assim que os testes
de integração trocam email/google/R2 por fakes, sem `vi.mock` de módulo nenhum.
`test/mocks/gateways.fake.ts` exporta `buildFakeGateways()`, que devolve um
objeto com `sentEmails` (array acumulando o que seria enviado),
`googleProfile` (perfil determinístico devolvido por qualquer `exchangeCode`),
e `r2` (fake que gera presigned URLs locais).
Testes de e2e sempre usam essa fake — nunca batem em rede real.

## Erros

Toda falha de negócio é uma subclasse de `AppError`
(`src/shared/errors.ts`): `NotFoundError`, `ValidationError`, `ConflictError`,
`UnauthorizedError`, `ForbiddenError`, `BadGatewayError`,
`ServiceUnavailableError`. O plugin `error-handler.ts` intercepta essas
subclasses e serializa `{ code, message, details }` com o `statusCode`
correto; erro de validação do Zod vira 400 automaticamente; qualquer coisa não
mapeada acima de 500 é logada como `unhandled error` e devolve 500 genérico
(sem vazar stack/mensagem interna pro cliente).

## Autenticação, tokens e hooks

`src/http/hooks/auth.ts` expõe dois `preHandler` globais, instalados em
`src/http/index.ts` antes de qualquer rota: `authHook` (lê `Authorization:
Bearer`, valida o JWT de acesso via `src/lib/jwt.ts` — EdDSA, chave própria —
e popula `req.user`) e `permissionsHook` (compara as personas do usuário
contra `config.permissions` da rota). Rotas com `config.public: true` pulam os
dois. `requireUser(req)` lança `UnauthorizedError` se não houver usuário
autenticado — usar dentro do controller quando a rota exige login.

Refresh token é rotativo: cada uso gera um novo token e marca o anterior como
`replacedById`; reapresentar um token já trocado é tratado como possível roubo
e revoga a família inteira (`tokens.service.ts`, `rotate()`). O cookie de
refresh (`udv_rt`, helper `cookies.ts`) é `httpOnly`, `sameSite: lax`,
`path: /auth`.

## Personas / permissões

`src/shared/permissions.ts` mapeia `platformAdmin` + papéis por loja
(`roles: Record<string, string>` — hoje sempre `{}`, ver pendência abaixo)
para um `Set<Persona>` (`customer`, `store_owner`, `store_admin`,
`store_staff`, `platform_admin`). `config.permissions` das rotas referencia
essas personas por nome (ver ADR-004).

## Checkout e reserva de estoque

O fluxo de checkout (Plano 3) é uma transação atômica que bloqueia estoque
antes do pagamento ser confirmado. Sequência:

1. `POST /orders` valida itens (produtos `in_stock`), calcula total com fee.
2. Dentro de uma transação Prisma:
   - Decrementa estoque: `updateMany({ where: { id, stock: { gte: qty } } })` —
     é atômico e impede overselling mesmo com requisições simultâneas.
   - Cria order com status `pending_payment`, expiração em 30 minutos.
   - Cria payment com status `pending`.
3. **Fora da transação** (nunca dentro): chama gateway (Stripe/Woovi) pra gerar
   payment intent/charge. Se falhar → `compensateFailedCheckout()` desfaz
   estoque, marca order `cancelled` e payment `failed`, devolve 502.
4. Gateway devolve `clientSecret` (Stripe) ou `brCode` (Woovi), retorna 201.
5. Cliente completa pagamento no frontend.
6. Webhook (`/webhooks/stripe` ou `/webhooks/woovi`) chega com confirmação:
   - Handler persiste evento com dedup `(provider, eventId)`.
   - Processa inline: `markPaid()` transiciona payment para `succeeded` e order
     para `paid`, grava outbox event `order.paid`.
   - Worker periodicamente reprocessa eventos presos em status `received` (crash
     recovery).
7. Outbox worker (`relayOutbox`) processa `order.paid` e dispara email de
   confirmação, marca evento como `processed`.
8. Se pedido expirou (30 min sem confirmação), worker `expireReservations`
   cancela e devolve estoque; payment fica `expired`.

**Caso especial — pagamento tardio de pedido cancelado:** payment chega como
`succeeded` via webhook, order já está `cancelled` (expirou ou foi cancelado
manualmente). `markPaid()` honra o `succeeded` (idempotência), mas order não
muda de `cancelled`. Loga erro; reembolso é manual.

## Webhooks

Integração com Stripe e Woovi por webhooks idempotentes. Ambas as rotas são
públicas (`config.public: true`) e recebem raw body (parser `parseAs: "buffer"`
no escopo do plugin `webhooksRoutes`).

### Stripe

- **Rota:** `POST /webhooks/stripe`, header `stripe-signature`.
- **Assinatura:** verificada via SDK Stripe (`stripe.webhooks.constructEvent`).
- **Tipos processados:**
  - `payment_intent.succeeded` → `markPaid()` (order `pending_payment` → `paid`).
  - `payment_intent.payment_failed`, `payment_intent.canceled` → cancela pedido
    pendente e devolve estoque.
  - `charge.refunded` → marca payment como `refunded` e order passa para esse
    estado (se em estado válido).

### Woovi

- **Rota:** `POST /webhooks/woovi`, header `x-openpix-signature`.
- **Assinatura:** HMAC-SHA1 base64 do raw body contra `WOOVI_WEBHOOK_HMAC_SECRET`.
- **Dedup:** eventId é `${event}:${charge.correlationID}` (Woovi não tem ID
  global; `correlationID` é nosso `payment.id`).
- **Tipos processados:**
  - `OPENPIX:CHARGE_COMPLETED` → `markPaid()`.
  - `OPENPIX:CHARGE_EXPIRED` → cancela pedido se ainda pendente.
  - `OPENPIX:CHARGE_REFUND` → marca payment como `refunded`.

### Handler de webhook

1. Verifica assinatura, rejeita se inválida (401).
2. Chama `storeWebhookEvent()`: tenta inserir `(provider, eventId, type, payload)`.
   Se já existe (dedup), retorna `false` silenciosamente.
3. Se novo: processa inline com `processWebhookEvents()` (aguarda, responde só
   após conclusão).
4. Devolve 200 `{ received: true }` sempre que assinatura é válida.

Worker reprocessa eventos com status `received` a cada 15 segundos (crash
recovery em caso de erro após persistir mas antes de processar).

## Workers in-process

Três workers em loop leve, inicializados em `src/server.ts` ao startup e parados
no graceful shutdown:

- **`expireReservations()`** — a cada 60s, encontra pedidos `pending_payment` com
  `expiresAt < now`, cancela e devolve estoque.
- **`relayOutbox()`** — a cada 10s, processa eventos de outbox com status
  `pending`, envia emails (atualmente só `order.paid`), marca `processed`.
  Falhas incrementam `attempts`; após 5 tentativas, marca `failed` (terminal).
- **`processWebhookEvents()`** — a cada 15s, reprocessa eventos webhook com
  status `received` (recovery de crashes entre persistir e processar).

Funções de tick são puras (testáveis sem `vi.useFakeTimers`); `setInterval`
fica só em `src/workers/index.ts` no `startWorkers()`. Testes chamam as funções
direto.

## Transições de status de Order

Order nascido como `pending_payment` pode seguir apenas um dos caminhos a seguir,
em ordem estrita (nenhuma volta atrás):

```
pending_payment → paid | cancelled
↓
(se paid)
paid → delivery_arranged | delivered | refunded
↓
delivery_arranged → delivered | refunded
↓
delivered → refunded
```

Qualquer outra transição é rejeitada com erro 409 `invalid_status_transition`.
`updateOrderStatus()` do repository exige explicitamente os status **de** válidos.

## Pendências para planos futuros (documentado aqui para não ficar implícito)

- **Outbox** (já implementado neste plano como exemplo): eventos de domínio
  (ex.: "pedido pago" disparando emails) usam tabela outbox + processamento
  assíncrono via worker, não side-effect síncrono dentro do service de escrita.

## Testes

Testes de integração usam `buildApp({ gateways: buildFakeGateways() })` +
`app.inject`, nunca `vi.mock`. `resetDb()` (`test/helpers/db.ts`) limpa as
tabelas relevantes em cada `beforeEach`. Todo teste novo segue TDD: escreve o
teste falhando, implementa o mínimo pra passar, roda a suíte inteira.
