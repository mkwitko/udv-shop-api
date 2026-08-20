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

## Encomendas (interests)

Uma **encomenda** (`ProductInterest`) é uma linha única de demanda de um cliente
por um produto `on_demand` específico de uma loja `active`. O par `(productId,
userId)` é único — múltiplas encomendas do mesmo cliente pelo mesmo produto não
são permitidas; um `POST /interests` que atualiza `qty`/`note` e reabre a
encomenda (`status: open`, `notifiedAt: null`) em vez de criar linha nova.

Ciclo de vida:
- **Criação/reabertura:** `POST /interests` exigindo `customer`, rejeita produto
  que não seja `on_demand` ou loja que não seja `active`.
- **Transições:** `open → notified | converted | cancelled`, depois
  `notified → converted | cancelled`; `converted` e `cancelled` são terminais
  (só via novo `POST` o cliente reabre).
- **Notificação de chegada:** `POST /stores/:slug/products/:productSlug/interests
  /notify` (admin+) marca até 500 encomendas `open → notified` de um produto
  específico e grava `interest.notified` no outbox para cada uma; email sai no
  relay de 10s, nunca inline.
- **Conversão automática:** evento `order.paid` no relay converte (via
  `updateMany` guardado) encomendas `open | notified` do comprador referentes aos
  produtos do pedido para `status: converted`, evitando duplicação de demanda.
- **Consultas:**
  - `GET /interests` (customer): lista encomendas do usuário por cursor, pode
    filtrar por status.
  - `GET /stores/:slug/interests` (staff+): lista encomendas da loja, filtra por
    status ou `productSlug` (cursor).
  - `GET /stores/:slug/interests/demand` (staff+): demanda agregada — soma só
    `open` e `notified`, por produto, ordenada por qty total desc, máximo 100
    produtos na resposta.
- **Cancelamento:** `DELETE /interests/:id` (customer) marca `open | notified →
  cancelled`; interesse convertido não pode ser cancelado (é compra, tem seu
  pedido).

Routes e permissões:
| Método | Rota | Personas | Efeito |
|--------|------|----------|--------|
| `POST` | `/interests` | `customer` | cria/reabre (`upsertOpen`) |
| `GET` | `/interests` | `customer` | lista do usuário (cursor + status filter) |
| `DELETE` | `/interests/:id` | `customer` | cancela `open/notified` |
| `GET` | `/stores/:slug/interests` | `staff+` | lista da loja (cursor + status/produto filter) |
| `POST` | `/stores/:slug/products/:productSlug/interests/notify` | `admin+` | marca `open → notified`, grava outbox |
| `GET` | `/stores/:slug/interests/demand` | `staff+` | agregado da loja (qty desc, teto 100) |

Repository (`InterestsRepository`) expõe: `upsertOpen`, `listMineCursor`,
`findByIdForUser`, `cancelMine`, `listByStoreCursor`, `aggregateDemand`,
`notifyArrival`, `convertForOrder`. Índices de banco:
- `product_interests(product_id, status)` — busca `notifyArrival` / agregado.
- `product_interests(user_id, created_at DESC, id DESC)` — cursor lista pessoal.
- `product_interests(product_id, user_id) UNIQUE` — garante uma linha por par.

## Repasses a parceiros (payouts)

Um **parceiro** (`Supplier`) é quem faz um produto da loja e recebe parte do valor da
venda: artesã, produtor, fornecedor da comunidade. O dinheiro da venda continua caindo
na conta da loja (direct charge, ADR-020) — não há divisão automática no gateway. O que
existe é **registro contábil**: quanto a loja deve a quem, e quanto já pagou.

Modelo:
- `Product.supplierId` + `Product.payoutKind` (`fixed_cents | percent_bps`) +
  `Product.payoutValue` formam o **acordo vigente**. Os três andam juntos: `null` nos três
  significa "a loja fica com tudo menos a taxa" (`normalizePayoutFields` recusa meio acordo
  com `payout_incomplete`).
- `OrderItem.supplierId` + `OrderItem.payoutCents` **congelam** o acordo no momento da
  compra, já multiplicados pela quantidade (`itemPayoutCents` no checkout). Mudar o acordo
  depois não reescreve venda passada.
- `SupplierSettlement` é um repasse que a loja já pagou (valor, data, observação, autor).

Saldo é sempre **derivado**, nunca materializado: soma de `order_items.payout_cents` de
pedidos em `PAYOUT_ORDER_STATUSES` (`paid`, `delivery_arranged`, `delivered`) menos a soma
dos settlements. Consequências disso:
- pedido `pending_payment` não gera repasse (pode expirar);
- `cancelled` e `refunded` saem da soma — um reembolso depois do repasse pago deixa o saldo
  **negativo**, e é assim que a loja vê que tem crédito com o parceiro;
- pagar mais do que o saldo é permitido (adiantamento).

`assertPayoutForStore` valida na escrita do produto, sempre com o trio efetivo e o preço
efetivo (baixar o preço de um produto com repasse combinado também é checado):
`supplier_not_found` (inclusive parceiro de outra loja), `supplier_inactive` e
`payout_exceeds_price` — repasse não pode passar de `preço − taxa da plataforma`.

Visibilidade: acordo comercial não é vitrine. `ProductResponse.payout` só vem preenchido
para membro da loja (`isStoreMember`); a resposta pública devolve `null`, sem o nome do
parceiro. E as rotas de repasse exigem **admin+**, não staff.

Routes e permissões:
| Método | Rota | Personas | Efeito |
|--------|------|----------|--------|
| `GET` | `/stores/:slug/suppliers` | `admin+` | lista parceiros (cursor, `all=true` inclui desativados) |
| `POST` | `/stores/:slug/suppliers` | `admin+` | cadastra (nome único por loja → 409) |
| `PATCH` | `/stores/:slug/suppliers/:supplierId` | `admin+` | edita, inclusive `active: false` |
| `GET` | `/stores/:slug/payouts` | `admin+` | saldo por parceiro + totais (teto 200 parceiros) |
| `GET` | `/stores/:slug/payouts/:supplierId` | `admin+` | extrato: 50 vendas + 50 pagamentos |
| `POST` | `/stores/:slug/payouts/:supplierId/settlements` | `admin+` | registra repasse pago |

Parceiro não é apagado — `active: false` tira das opções e o histórico fica. Índices:
`suppliers(store_id, name) UNIQUE`, `order_items(supplier_id)`, `products(supplier_id)`,
`supplier_settlements(supplier_id, paid_at DESC, id DESC)`.

## Extrato e exportação (reports)

`GET /stores/:slug/statement?months=6` (admin+) fecha a conta da loja por mês:
`payments` com `status: succeeded` — pedido reembolsado sai da soma porque o pagamento
vira `refunded` — mais a soma de `order_items.payout_cents` do mesmo período.
`netCents = vendas + doações − taxa − repasse`. Duas queries e não um join só: somar
itens junto com pagamentos multiplicaria a receita pelo número de itens do pedido.
`payoutsOpenCents` traz só saldos positivos, para bater com a aba Repasses.

Exportação em CSV vive fora do OpenAPI (`hide: true`): devolve arquivo, não JSON, e o
cliente gerado espera JSON. O front baixa com um fetch próprio (`lib/api/download.ts`).

| Método | Rota | Personas | Efeito |
|--------|------|----------|--------|
| `GET` | `/stores/:slug/statement` | `admin+` | extrato por mês + totais |
| `GET` | `/stores/:slug/orders.csv` | `admin+` | pedidos em planilha |
| `GET` | `/stores/:slug/interests.csv` | `admin+` | encomendas em planilha |

O CSV usa `;`, BOM e vírgula decimal (planilha brasileira), escapa aspas e neutraliza
célula começando com `=`, `+`, `-` ou `@` — texto que a planilha executaria como fórmula.
O telefone da lista de encomendas sai mascarado, igual à tela.

## Domínio próprio da loja

`Store.customDomain` (único) + `customDomainVerifiedAt`. Fluxo: a loja grava o endereço
(`PUT`), aponta um CNAME para `CUSTOM_DOMAIN_TARGET`, e pede verificação (`POST`), que
consulta o DNS pelo gateway `dns` e grava — ou apaga — a data. **Só domínio verificado
resolve**: `GET /stores/by-domain?host=` (público) é o que o SSR do front consulta para
descobrir de quem é o Host. Trocar o endereço zera a verificação.

`parseStoreDomain` normaliza o que a pessoa colar (protocolo, porta, ponto final,
maiúsculas) e recusa: endereço inválido, endereço da plataforma (`WEB_ORIGIN`) e o
próprio alvo do CNAME — seria capturar tráfego alheio. `CUSTOM_DOMAIN_TARGET` vazio
desliga a feature inteira (`enabled: false` na resposta).

| Método | Rota | Personas | Efeito |
|--------|------|----------|--------|
| `GET` | `/stores/:slug/domain` | `admin+` | estado e instruções de DNS |
| `PUT` | `/stores/:slug/domain` | `owner` | grava (409 se já for de outra loja) |
| `DELETE` | `/stores/:slug/domain` | `owner` | solta o endereço |
| `POST` | `/stores/:slug/domain/verify` | `owner` | consulta o DNS e grava o resultado |
| `GET` | `/stores/by-domain` | público | resolve Host → loja verificada |

## Campanhas e doações

Uma **campanha** (`Campaign`) é uma arrecadação de fundos para um objetivo
específico de uma loja, com meta de valor total. Pagamentos de doações nascem
com status `pending_payment` (checkout) ou `pending_invoice` (subscrição mensal),
transitam para `paid` quando confirmados via webhook, ou para `cancelled` se
expiram por TTL (30 minutos para pagamentos únicos, per-cycle para subscrições).

Progresso da meta é calculado dinamicamente por `groupBy(paymentStatus)` no
repository (nunca denormalizado na coluna) — suma de `amount` para status `paid`,
sem contar tentativas falhadas. Visibilidade de campanha (quem consegue ler e
fazer doação) é determinada pela regra em D10: cliente vê listagem pública se
`campaign.visibleAt <= now` e `campaign.archivedAt` é nulo; owner e staff vêem
suas próprias mesmo antes de `visibleAt`.

Transições de `CampaignStatus`:
```
draft → active | archived
active → paused | finished | archived
paused → active | archived
finished (terminal)
archived (terminal)
```

A coluna `finishedAt` é definida quando a transição acontece (`active | paused → finished`);
`finished` marca permanente na exibição pública (campanha já encerrada, sem novos
donativos aceitos).

## Doação mensal

Uma **subscrição mensal** (`DonationSubscription`) é um agendamento de cobrança
recorrente (mensal, ancorada no dia de criação) vinculado a uma campanha. Cada
ciclo gera uma **doação filha** (`Donation`) com status `pending_invoice` e uma
invoice criada no Stripe Billing ou manualmente rastreada.

Diferença fundamental de agregado:
- **Doação única** (`Donation` sem `subscriptionId`): usa `destination charge`
  (fee é `application_fee_amount` lump-sum na transação).
- **Doação mensal** (nascida de `DonationSubscription`): usa `direct charge` na
  conta conectada (fee é `application_fee_percent` da invoice, pois Stripe Billing
  exige; restrição de design em D3).

Ciclo:
1. `POST /campaigns/:id/subscriptions` cria `DonationSubscription` com `status:
   subscription_created`, grava `anchorDate` (hoje) e `providerSubscriptionId`.
2. No hook de `subscription_create` do Stripe Billing (webhook Connect), valida
   idempotência por `providerInvoiceId` e marca `subscription_created → active`.
3. A cada `subscription_cycle` (webhook Connect), cria `Donation` filha (`status:
   pending_invoice`, `subscriptionId`, `providerInvoiceId`) e tenta `markPaid()`
   se a invoice estiver `paid` já.
4. Cancelamento via `DELETE /subscriptions/:id` marca `subscription_cancelled`;
   nenhum `subscription_cycle` futuro nasce; doações já criadas continuam como estão.

Eventos webhook chegam via POST `/webhooks/stripe` **Connect** — são eventos do
tipo `billing.subscription.*` e `invoice.*`, que o processador roteia internamente
(mesmo endpoint, verificação de `stripe-account` header).

Woovi mensal (Pix recorrente) **fica fora do escopo até o Plano 6** (D4) —
hoje só Stripe Billing é suportado. Risco de decisão de produto está registrado
em ADR-017 (veja também § 11 da spec).

## Sorteio

Um **sorteio** (`Raffle`) pertence a uma campanha e vale para um **período**. Uma
campanha pode ter vários: campanha longa (reforma que dura um ano) tem tipicamente
um sorteio por mês, com prêmios próprios, sem fragmentar a meta em várias
campanhas.

Identidade e janela:
- `sequence` (`Int`) — ordem dentro da campanha, atribuída pelo servidor (`max+1`
  dentro da transação) e usada na URL. `@@unique([campaignId, sequence])`.
- `startsAt` / `endsAt` — a janela, semiaberta `[startsAt, endsAt)`. `endsAt` nulo
  é o sorteio corrente; sortear fecha a janela (`endsAt = drawnAt`), porque
  sorteio realizado não recebe mais doação — sem isso ele valeria até o infinito e
  bloquearia qualquer sorteio novo, sem saída, já que reconfigurar exige `open`.
- Janelas de sorteios da mesma campanha não podem se sobrepor (409
  `raffle_window_overlap`, ou `raffle_open_ended_conflict` quando o estorvo é o
  corrente sem fim).

**Resolução doação → sorteio** (`raffle-window.ts`), a partir de
`Donation.paidAt` (`createdAt` é quando o checkout abriu; um Pix pago horas
depois cairia na janela errada):
1. o sorteio cuja janela contém `paidAt` — **de qualquer status**; concede números
   só se ele estiver `open`;
2. senão, o sorteio `open` com o menor `startsAt` posterior a `paidAt` — o próximo
   que começar;
3. senão, nenhum: a doação fica pendente até alguém criar um sorteio que a cubra.

O passo 1 ignorar o status é o que impede a doação de agosto — cujo sorteio já foi
realizado — de escorregar para setembro pelo passo 2 e concorrer duas vezes com o
mesmo dinheiro.

Criar um sorteio **reavalia** as doações `paid` da campanha com
`raffleGranted = false` e concede as que resolvem para ele (backfill). Sem isso a
regra do passo 2 só valeria para quem doasse depois de o sorteio existir.

Concessão de números (worker `relayOutbox`, evento `donation.received`):
- `Donation.raffleGranted` reivindica a doação (`updateMany` guardado) — uma doação
  concede em no máximo um sorteio, então o booleano basta.
- `Raffle.nextNumber` é **por sorteio**: cada sorteio numera a partir de 1. A faixa
  é reservada por `UPDATE ... RETURNING` guardado por `status = 'open'`, que trava
  a linha e recusa número emitido depois do draw.
- Doação abaixo de `centsPerNumber` gera zero números e **não** marca
  `raffleGranted`: o passo 1 a resolve sempre para a mesma janela, então conceder
  zero é idempotente.
- Estorno apaga as entradas do sorteio ainda `open` e devolve
  `raffleGranted = false`.

**Algoritmo de sorteio:** `sha256-counter-v1`, determinístico e auditável. A seed
(16 bytes aleatórios) nasce no `draw`, nunca antes: publicá-la de véspera deixaria
o doador calcular quanto doar para cair no número vencedor (D7/ADR-017). Para o
prêmio de posição `p`: `sha256(seed + ":" + p)` → primeiros 8 bytes como inteiro →
`mod` do tamanho do pool restante → índice no pool ordenado por número asc; o
vencedor sai do pool, então ninguém ganha dois prêmios. Sorteio sem participante é
recusado (`raffle_has_no_entries`) e continua `open`.

Rotas (todas sob a campanha, registradas em `campaigns/index.ts`):

| Método | Rota | Auth |
|---|---|---|
| POST | `/stores/:slug/campaigns/:campaignSlug/raffles` | owner/admin |
| GET | `/stores/:slug/campaigns/:campaignSlug/raffles` | público |
| GET | `/stores/:slug/campaigns/:campaignSlug/raffles/:sequence` | público |
| PUT | `/stores/:slug/campaigns/:campaignSlug/raffles/:sequence` | owner/admin |
| POST | `/stores/:slug/campaigns/:campaignSlug/raffles/:sequence/draw` | owner/admin |
| PATCH | `/stores/:slug/campaigns/:campaignSlug/raffles/:sequence/status` | owner/admin |
| GET | `/stores/:slug/campaigns/:campaignSlug/raffles/:sequence/entries` | público |

`CreateCampaignBody.raffle` cria o sorteio de `sequence 1` na mesma transação da
campanha: com duas chamadas, falha no sorteio deixaria a campanha nascida pela
metade sem ninguém saber.

**Cancelar e reabrir** (`PATCH .../status`, `open` ↔ `cancelled`): cancelar apaga as
entradas, devolve `raffleGranted = false` e zera `nextNumber`; reabrir revalida a
janela (outro sorteio pode tê-la ocupado) e refaz o backfill. Cancelado é ignorado na
resolução e na sobreposição — ele não aconteceu, então não captura doação nem bloqueia
o substituto no mesmo período. Sorteio `drawn` não transita
(`invalid_raffle_transition`): desfazer um resultado publicado destrói a
auditabilidade que é o ponto do sorteio.

**Mascaramento de identidade (D11):** rota pública de participantes devolve
`maskName()` — `"Maria Silva"` vira `"Maria S."`, doação anônima vira
`"Doador anônimo"`. Vale também para o vencedor: entregar o prêmio é da gestão,
que vê identidade completa. Email, telefone e id jamais saem daqui.

## Onboarding do núcleo (Connect)

Antes de vender ou receber doação, o núcleo precisa de uma conta que receba o
dinheiro. São dois caminhos independentes, e a loja pode ter os dois.

**Stripe (cartão).** `POST /stores/:slug/connect/stripe/link` (owner) cria a conta
conectada **standard** se ainda não existir, grava `stripeAccountId` e devolve um
Account Link de onboarding hospedado. A conta é persistida *antes* de gerar o link:
se a criação do link falhar, o retry reusa a conta em vez de abrir uma segunda conta
para o mesmo núcleo. O link é de uso único e expira em minutos, então a rota gera um
novo a cada chamada em vez de guardar a URL.

Terminar o onboarding não é a mesma coisa que voltar para o site: o Account Link
redireciona o usuário sem nenhuma garantia de que o Stripe habilitou a conta. Quem diz
a verdade é o webhook `account.updated`, que espelha `charges_enabled`,
`payouts_enabled` e `details_submitted` nas colunas `stripe*Enabled`/`stripeDetailsSubmitted`
da loja (`stripeAccountId` é `@unique` justamente para o evento resolver a loja pelo id
da conta). `GET /stores/:slug/connect` serve essas colunas; enquanto
`detailsSubmitted` é falso — a janela em que o núcleo fica olhando a tela e o valor
envelhece a cada passo dado no Stripe — ele relê o Stripe e regrava. Depois disso, zero
chamada externa.

**Woovi (Pix).** `PUT /stores/:slug/connect/woovi` (owner) cria a subconta na Woovi e só
então grava `wooviPixKey`/`wooviSubaccountId`. A ordem importa: a cobrança Pix usa
`splits[].pixKey` com `SPLIT_SUB_ACCOUNT`, e uma chave gravada sem subconta virou Pix
quebrado no checkout. O formato da resposta da Woovi ainda não foi verificado contra a
conta real (risco registrado na §11 da spec) — o gateway lê o id de forma defensiva e cai
para a própria chave.

Nenhuma resposta desta slice devolve `stripeAccountId`, `wooviPixKey` ou
`wooviSubaccountId`: o front só precisa saber se está conectado e se já pode cobrar.

## Assinatura SaaS do núcleo (billing)

A plataforma cobra uma assinatura do núcleo. Ela roda na conta **da plataforma**, não
passa por Connect e não tem `application_fee` — é receita direta.

- `POST /stores/:slug/billing/checkout` (owner) → Checkout Session em modo
  `subscription`, com `storeId` em `metadata` **e** em `subscription_data.metadata`.
  Reusa o `stripeCustomerId` quando já existe, para manter histórico e método de
  pagamento entre tentativas. 409 se já houver assinatura `active`/`trialing`.
- `POST /stores/:slug/billing/portal` (owner) → sessão do portal do Stripe (trocar cartão,
  cancelar). 409 sem assinatura, porque o portal é por customer.
- `GET /stores/:slug/billing` (admin+) → `status`, `currentPeriodEnd`,
  `cancelAtPeriodEnd`. Nunca devolve `stripeCustomerId`/`stripeSubscriptionId`.

`StoreSubscription` tem `@unique` em `storeId`: é isso que impede dois checkouts
concorrentes virarem duas assinaturas cobradas.

**Efeito no status da loja**, aplicado na mesma transação que grava a assinatura:

| Status da assinatura | Loja |
|---|---|
| `active`, `trialing` | `pending` → `active` (e só de `pending`) |
| `past_due`, `paused` | inalterado — é carência |
| `canceled`, `unpaid`, `incomplete_expired` | `active` → `suspended` |

Uma loja `suspended` nunca é reativada por assinatura em dia: suspensão é decisão de
moderação da plataforma (ADR-006), e quem a reverte é o `platform_admin`. Já
`POST /billing/checkout` **não** usa `requireWritableStore` — uma loja suspensa por falta
de pagamento precisa justamente poder assinar de novo.

O período vem de `items.data[0].current_period_end`: em Basil+ o campo saiu do topo da
Subscription e vive no item.

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
  - `invoice.paid` **(conta conectada)** → ciclo de doação mensal.
  - `customer.subscription.deleted` **(conta conectada)** → marca a doação mensal
    como cancelada.
  - `account.updated` → espelha as capacidades da conta conectada na loja.
  - `checkout.session.completed` **(plataforma)** → guarda o customer da assinatura SaaS.
  - `customer.subscription.created|updated|deleted` **(plataforma)** → status da
    assinatura SaaS e transição de status da loja.

**Um endpoint, duas origens.** O mesmo `/webhooks/stripe` recebe eventos da conta da
plataforma e das contas conectadas (o endpoint precisa estar registrado com
`connect: true` no Stripe para receber os últimos). Tipos como
`customer.subscription.deleted` existem nos dois mundos e significam coisas diferentes —
cancelar a doação mensal de um doador, ou tirar a loja do ar. O que decide é o campo
`account` do evento, presente só quando ele nasce numa conta conectada: os ramos de
doação exigem `account` presente, os de billing exigem ausente. Cobrança de pedido e
doação única não entram nessa conta porque são *destination charges*, criadas na conta da
plataforma — os eventos delas chegam sem `account`, como sempre chegaram.

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
  a claim existe para evitar. Processa (`order.paid` dispara email; `donation.paid`
  gera números de sorteio; `payment.orphaned` e `subscription.cycle` só logam erro,
  sem email — são alertas operacionais), marca `processed` e limpa `claimedBy`/`claimedAt`.
  Falhas voltam o evento para `pending` e incrementam `attempts` (claim preservada
  até o próximo ciclo de reivindicação, que a sobrescreve); após 5 tentativas,
  marca `failed` (terminal) e também limpa `claimedBy`/`claimedAt`.
- **`processWebhookEvents()`** — a cada 15s, reprocessa eventos webhook com
  status `received` (recovery de crashes entre persistir e processar).
- **`doacoes`** — ciclo de processamento de doações mensais (webhooks
  `subscription_cycle` do Stripe Billing): a cada intervalo configurável (ex.:
  60s), lê eventos pendentes de `subscription_cycle`, cria doações filhas e
  tenta marcá-las `paid` se invoice já estiver confirmada (idempotência por
  `providerInvoiceId`).

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
- **Reembolso de doação por rota da gestão** — o reembolso já funciona pelo webhook
  (`charge.refunded` devolve os números do sorteio e marca a doação), mas não existe
  `POST /donations/:id/refund` para a gestão acionar, com o fluxo de conformidade
  (auditoria de doador, prevenção de fraude).
- **Woovi mensal (Pix recorrente)** — integração com `subscription`-like da Woovi
  ainda não existe naquele SaaS (status em fevereiro de 2026), junto com a revisão de
  risco jurídico da § 11 da spec.
- **Assinatura SaaS via Pix** — hoje só cartão (Stripe Billing na conta da plataforma).
- **Formato da subconta Woovi** — `createSubAccount` posta em `/api/v1/subaccount` e lê a
  resposta de forma defensiva; falta confirmar contra a conta real.
- **Ciclo mensal alimenta campanha `finished`** e **`countEntries` materializa um
  `groupBy` por participante em rota pública** — achados parkados na revisão do plano 5.

## Testes

Testes de integração usam `buildApp({ gateways: buildFakeGateways() })` +
`app.inject`, nunca `vi.mock`. `resetDb()` (`test/helpers/db.ts`) limpa as
tabelas relevantes em cada `beforeEach`. Todo teste novo segue TDD: escreve o
teste falhando, implementa o mínimo pra passar, roda a suíte inteira.
