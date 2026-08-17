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
`succeeded` via webhook depois que o pedido já não está mais `pending_payment`
(expirou, foi cancelado manualmente, ou a intent falhou e foi retentada com
sucesso). `markPaid()` reivindica o payment a partir de
`pending | expired | failed | cancelled` — não só `pending` — e sempre honra o
`succeeded` (idempotência); a order não muda de `cancelled`. Além do log de
erro, grava um `OutboxEvent` `payment.orphaned` (`{ orderId, paymentId }`) na
mesma transação, para o reembolso manual ficar consultável em vez de só
aparecer no stdout. Ver ADR-012.

## Webhooks

Integração com Stripe e Woovi por webhooks idempotentes. Ambas as rotas são
públicas (`config.public: true`) e recebem raw body (parser `parseAs: "buffer"`
no escopo do plugin `webhooksRoutes`).

### Stripe

- **Rota:** `POST /webhooks/stripe`, header `stripe-signature`.
- **Assinatura:** verificada via SDK Stripe (`stripe.webhooks.constructEvent`).
- **Tipos processados:**
  - `payment_intent.succeeded` → `markPaid()` (order `pending_payment` → `paid`).
  - `payment_intent.canceled` → cancela pedido pendente e devolve estoque
    (terminal).
  - `payment_intent.payment_failed` → **não** cancela nem devolve estoque; só
    loga um `warn`. Dispara em toda tentativa recusada e a mesma intent pode
    ser retentada e ter sucesso depois — o worker de expiração de 30 min
    continua sendo o único dono da liberação de reserva.
  - `charge.refunded` → marca payment como `refunded` e order passa para esse
    estado (se em estado válido; aceita payment `succeeded` ou
    `refund_pending`).

### Woovi

- **Rota:** `POST /webhooks/woovi`, header `x-openpix-signature`.
- **Assinatura:** HMAC-SHA1 base64 do raw body contra `WOOVI_WEBHOOK_HMAC_SECRET`.
- **Dedup:** eventId é `${event}:${charge.correlationID}` (Woovi não tem ID
  global; `correlationID` é nosso `payment.id`).
- **Tipos processados:**
  - `OPENPIX:CHARGE_COMPLETED` → `markPaid()`.
  - `OPENPIX:CHARGE_EXPIRED` → cancela pedido se ainda pendente.
  - `OPENPIX:CHARGE_REFUND` → marca payment como `refunded` (aceita `succeeded`
    ou `refund_pending` como status anterior).
  - `charge.correlationID` é validado como UUID (`z.string().uuid()`) antes de
    ser usado como `payment.id`; um valor não-UUID (webhook de teste/ping da
    Woovi) é ignorado — o evento é marcado `processed` sem efeito, nunca
    estoura P2023 pro Prisma nem vira `failed` terminal.

### Reembolso (admin da loja)

`POST /stores/:slug/orders/:id/refund` não muda o status do pedido — isso só
acontece quando o webhook de confirmação chega (`charge.refunded` /
`OPENPIX:CHARGE_REFUND`, acima). Para evitar reembolso duplicado na janela
entre a chamada e o webhook (segundos a minutos), o endpoint reivindica o
pagamento atomicamente antes de chamar o gateway:
`payment.updateMany({ where: { OR: [{ status: "succeeded" }, { status:
"refund_pending", updatedAt: { lt: now - 15min } }] }, data: { status:
"refund_pending" } })`. O segundo ramo do `OR` existe porque uma claim que
nunca é confirmada pelo webhook (crash, shutdown, operador matando o processo
no meio da requisição) não pode travar o pagamento em `refund_pending` para
sempre: passados 15 minutos (`STALE_REFUND_CLAIM_MS`) sem confirmação, a claim
é considerada abandonada e pode ser refeita — a própria escrita do `updateMany`
atualiza `updatedAt` (`@updatedAt`), o que rearma a janela para a nova claim. O
pré-check do controller permite `refund_pending` passar adiante exatamente por
isso: rejeitar incondicionalmente ali faria todo retry 409 para sempre, sem
jeito de o admin reconduzir. Se a claim falhar (`count !== 1` — pagamento em
outro status, ou um `refund_pending` genuinamente em andamento e ainda não
expirado), responde 409 `refund_already_requested` sem tocar o gateway. Se a
chamada ao gateway falhar depois da claim, ela é revertida para `succeeded`
antes do erro subir. A `refundCorrelationID` enviada à Woovi é determinística
(`refund-${payment.id}`) — é a chave de idempotência da Woovi, então não pode
ser um UUID novo a cada tentativa; o mesmo valor é usado como chave de
idempotência (`idempotencyKey`) na chamada `stripe.refunds.create`, pelo mesmo
motivo — sem isso, uma falha de rede *depois* de a Stripe já ter aceitado o
reembolso soltaria a claim de volta para `succeeded` com o dinheiro já fora, e
todo retry bateria em `charge_already_refunded`.

### Handler de webhook

1. Verifica assinatura, rejeita se inválida (401).
2. Chama `storeWebhookEvent()`: tenta inserir `(provider, eventId, type, payload)`.
   Se já existe (dedup), retorna `null` silenciosamente.
3. Se novo: processa inline só a linha que acabou de gravar
   (`processWebhookEvents({ eventId })`, aguarda, responde só após conclusão).
   Nunca drena o backlog inteiro dentro da requisição do provedor — isso é
   trabalho exclusivo do worker de 15s, evitando timeout de leitura do
   provedor numa fila congestionada.
4. Devolve 200 `{ received: true }` sempre que assinatura é válida.

Worker reprocessa eventos com status `received` a cada 15 segundos (crash
recovery em caso de erro após persistir mas antes de processar) — sem
`eventId`, drena até 50 linhas.

## Workers in-process

Três workers em loop leve, inicializados em `src/server.ts` ao startup e parados
no graceful shutdown. `startWorkers()` envolve cada tick numa guarda de
reentrância (um `setInterval` que dispara enquanto a invocação anterior ainda
está rodando é simplesmente pulado, não empilhado) — protege contra tick lento
sobrepondo o próximo em instância única; múltiplas instâncias da API ainda
dependem da claim atômica do outbox abaixo.

- **`expireReservations()`** — a cada 60s, encontra até 200 pedidos
  `pending_payment` com `expiresAt < now`, cancela e devolve estoque.
- **`relayOutbox()`** — a cada 10s: primeiro reivindica (`updateMany`) de volta
  para `pending` qualquer evento `processing` cujo `claimedAt` seja mais velho
  que `STALE_CLAIM_MS` (5 min) — sem essa reciclagem, um evento cuja claim
  nunca chega ao fim (crash, shutdown, exceção entre a claim e a atualização
  por linha) ficaria `processing` para sempre, já que toda consulta aqui só
  olha `pending`. Em seguida reivindica atomicamente até 50 eventos `pending`,
  marcando `processing` e gravando um token por tick (`claimedBy`, um UUID
  gerado na hora) junto com `claimedAt` — evita duplo envio de email quando um
  tick demorado se sobrepõe ao próximo, ou quando há mais de uma instância da
  API. A releitura seguinte filtra por esse token
  (`status: "processing", claimedBy: token`), não só por `status`: numa claim
  parcial (`createdAt` empatado pode fazer as janelas de 50 linhas de duas
  instâncias divergirem) uma releitura sem o token pegaria linhas que a *outra*
  instância acabou de reivindicar e reenviaria o email dela — o próprio bug que
  a claim existe para evitar. Processa (`order.paid` dispara email;
  `payment.orphaned` só loga erro, sem email — é alerta operacional), marca
  `processed` e limpa `claimedBy`/`claimedAt`. Falhas voltam o evento para
  `pending` e incrementam `attempts` (claim preservada até o próximo ciclo de
  reivindicação, que a sobrescreve); após 5 tentativas, marca `failed`
  (terminal) e também limpa `claimedBy`/`claimedAt`.
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
