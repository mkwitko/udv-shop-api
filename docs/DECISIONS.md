# Decisões de arquitetura (ADRs) — udv-shop-api

Registro curto das decisões técnicas relevantes e o porquê. Formato: contexto,
decisão, consequências. Adicione um ADR novo sempre que uma decisão estrutural
mudar (ver skill `docs-sync`).

## ADR-001: Prisma em vez de Drizzle

**Contexto:** precisávamos escolher o ORM/query builder para o Postgres do
projeto.

**Decisão:** usar Prisma (`@prisma/client` + `prisma migrate`) em vez de
Drizzle. Foi um pedido explícito do produto, não uma escolha técnica nossa.

**Consequências:** migrations declarativas via `schema.prisma`, client
totalmente tipado gerado a partir do schema. Em troca, abrimos mão do SQL
mais "à mão" e de alguns recursos de performance que o Drizzle expõe mais
diretamente. O acesso ao Prisma fica isolado nos repositories
(`createXRepository(db)`) para não vazar `PrismaClient` pelas services.

## ADR-002: Zod + fastify-type-provider-zod (em vez de JSON Schema puro)

**Contexto:** o frontend usa Kubb para gerar um client HTTP tipado a partir da
especificação OpenAPI da API.

**Decisão:** todo schema de rota é escrito em Zod e plugado via
`fastify-type-provider-zod`, que gera o JSON Schema/OpenAPI automaticamente e
também faz a validação de request/serialização de response em runtime.

**Consequências:** um único schema serve três papéis (validação, tipo
TypeScript, documentação OpenAPI) — sem essa tríade divergir com o tempo. Toda
rota precisa de `operationId` estável, porque é o nome do método que o Kubb
gera no client; renomear `operationId` é uma mudança breaking para o
frontend.

## ADR-003: JWT EdDSA próprio + refresh rotativo (sem Cognito)

**Contexto:** era possível terceirizar autenticação para um serviço gerenciado
(ex.: Cognito, Auth0).

**Decisão:** implementar autenticação própria: access token JWT assinado com
EdDSA (chave própria, `src/lib/jwt.ts`), TTL curto (`ACCESS_TOKEN_TTL_S`), e
refresh token opaco rotativo persistido no banco (`RefreshToken`, família por
login, detecção de reuso revoga a família inteira).

**Consequências:** controle total sobre o formato do token, sem dependência
de infraestrutura de terceiro nem custo por usuário ativo. Em troca, a equipe
é responsável por manter a rotação de chaves (`scripts/generate-keys.ts`) e
a lógica de revogação/reuso corretas — esse é o ponto mais sensível do
sistema de auth e por isso tem cobertura de teste dedicada
(`tokens.service.test.ts`, `auth-refresh-logout.test.ts`).

## ADR-004: personas como modelo de permissão (não papéis crus)

**Contexto:** o sistema tem múltiplos perfis de acesso (admin da plataforma,
dono de loja, staff de loja, cliente) e vai crescer.

**Decisão:** rotas nunca checam papel bruto do banco diretamente; toda checagem
passa por uma `Persona` (`src/shared/permissions.ts`) derivada do usuário
(`platformAdmin` + papéis por loja). `config.permissions` das rotas referencia
personas (`{ any: ["customer"] }`), nunca strings de papel específicas de
tabela.

**Consequências:** a origem do papel pode mudar (hoje é só
`platformAdmin`; papéis por loja chegam no Plano 2) sem que nenhuma rota
precise ser reescrita — só o mapeamento em `personasOf()` muda. Toda rota
autenticada é obrigada a declarar `config.permissions` ou `config.public`;
esquecer os dois derruba a rota em runtime (`AUTH_NO_PERMISSIONS`), de
propósito.

## ADR-005: dois repositórios separados (API e frontend)

**Contexto:** era possível manter API e frontend num monorepo único.

**Decisão:** manter `udv-shop-api` e o frontend em repositórios Git
separados, com o client HTTP do frontend gerado a partir do OpenAPI publicado
pela API (via Kubb).

**Consequências:** deploys e versionamento independentes; o contrato entre os
dois é o OpenAPI (daí a rigidez do ADR-002 sobre `operationId`/schema). Em
compensação, mudanças que tocam os dois lados exigem coordenar duas PRs em vez
de uma só.

## ADR-006: criação de loja aberta a qualquer usuário autenticado, nasce `pending`

**Contexto:** lojas começam com estado `draft` (interna) ou `pending` (aguardando
ativação humana), e idealmente qualquer usuário autenticado deveria conseguir
criar uma. Mas ativação automática seria prematura (depende de billing/SaaS).

**Decisão:** `POST /stores` é protegida por `{ any: ["customer"] }` (qualquer
autenticado); loja nova nasce com `status: pending`. Ativação (transição para
`active`) exige `platform_admin`, até o Plano 6 adicionar automação de billing.

**Consequências:** loja criada fica invisível no catálogo público e em listagens
gerais até aprovação. Owner da loja pode editar draft, mas não ativar sozinho.
Reduz spam/phishing; facilita auditoria de novos sellers.

## ADR-007: slug de produto imutável após criação

**Contexto:** URLs de produto (`/stores/:slug/products/:productSlug`) precisam
ser estáveis para SEO (links antigos não quebram) e marketing (QR codes,
impressos).

**Decisão:** `slug` é gerado uma única vez na criação e nunca pode ser mudado.
Se o usuario quiser mudar slug, deve criar um novo produto e arquivar o antigo.

**Consequências:** garante URLs permanentes; evita complexidade de redirects
ou histórico de slugs. Usuário tem que refazer trabalho de configuração, mas
é a escolha certa a longo prazo.

## ADR-008: upload de imagem via presigned PUT R2, com whitelist de content-type

**Contexto:** precisamos armazenar imagens de produto em cloud storage (R2) sem
expor credenciais S3/R2 direto ao frontend.

**Decisão:** API gera uma presigned URL PUT válida por tempo curto (ex.: 15min),
com headers restritos (`content-type` whitelist, ex.: `image/jpeg`, `image/png`).
Frontend faz upload direto via PUT. Chave é namespaced: `stores/<storeId>/products/<productId>/<filename>`.

**Consequências:** frontend não conhece credenciais R2; API controla quotas/tipos
permitidos. Upload é rápido (não passa pela API). Filename é gerado pelo
frontend para garantir unicidade + tipo correto (ex.: UUID + `.jpg`).
Em caso de roubo de presigned URL, limite de tempo (`expirationSeconds`) e
whitelist de content-type mitigam dano.

## ADR-009: reserva de estoque = decremento no checkout

**Contexto:** ao criar pedido, estoque precisa ser reservado antes do pagamento
ser confirmado. Duas abordagens: (1) decrementar no checkout, com worker
devolvendo após expiração; (2) decrementar só ao receber webhook `paid`.

**Decisão:** decrementar atomicamente **no checkout** (opção 1). Abordagem 2
permitiria overselling durante a janela de pagamento (ex.: 10 unidades, 15
checkouts simultâneos todos com sucesso inicial, só 1 webhook chega).

**Consequências:** estoque "preso" fica reservado por até 30 minutos (TTL de
pedido `pending_payment`). Custo: consultas de produto podem ver estoque
indisponível mesmo com pagamento não confirmado. Ganho: impossível oversell, e
checkout rápido (rejeita logo se sem estoque) — melhor UX que deixar escolher
e depois falhar no webhook. Worker `expireReservations` devolve estoque se
pedido expirou sem pagamento.

## ADR-010: webhook processa inline + worker reprocessa

**Contexto:** webhook pode falhar entre persistência e processamento (crash,
timeout). Duas abordagens: (1) persist + process inline, worker reprocessa
presos; (2) persist só, worker processa tudo depois.

**Decisão:** persist + process inline, com worker de recovery (opção 1).

**Consequências:** latência de confirmação (order → `paid`, email enviado)
fica baixa e determinística em testes (sem `setInterval`). Idempotência
(`markPaid`, `cancelPendingOrder`) garante segurança se mesmo evento é
processado 2×. Worker cobre crash entre persistir e processar (evento fica
`received`, worker lê e processa depois). Evento com erro durante processamento
marca-se `failed` + campo `error` (terminal — análise manual, sem retry
automático).

## ADR-011: produto `on_demand` não é comprável no checkout

**Contexto:** produtos podem ter `availability: in_stock | on_demand`. Alguns
modelos de negócio permitem compra de itens sob encomenda.

**Decisão:** neste plano (Plano 3), checkout só aceita produtos `in_stock`.
`on_demand` vira `product_interests` no Plano 4 (modelo diferente de reserva).

**Consequências:** checkout sempre rejeita `product_not_orderable` se slug
encontrado mas `availability != in_stock`. Simplifica lógica de reserva: não
precisa modelar "interesse" vs "reserva de verdade". Plano 4 adiciona interesse
e alerta de restock.

## ADR-012: reembolso não devolve estoque nem reativa pedido; pagamento tardio é idempotente

**Contexto:** após pedido `paid`, se cliente pedir reembolso, múltiplas
consequências possíveis: (a) devolver estoque, (b) reativar pedido, (c)
nenhuma das duas. Também: webhook de pagamento chega **após** pedido ser
cancelado (expirou).

**Decisão:** (1) reembolso **não** devolve estoque nem reativa pedido —
contabilidade assume estoque já foi "baixado" (produto em trânsito/entregue,
ajuste de inventário é manual). (2) Pagamento tardio para pedido não mais
`pending_payment` (expirado, cancelado, etc.): aceita payment como `succeeded`
(idempotência), order **não** volta a ficar pagável, loga erro, reembolso é
manual.

**Consequências:** fluxo de reembolso fica simples (só call para gateway +
transição de status). Reembolso manual é responsabilidade da loja se quiser
reativar pedido ou devolver estoque. Evita race condition entre webhook
(marcar paid) e expirador (marcar cancelled).

**Atualização (correção da revisão final, supera o bloco de código original do
Plano/Step 3 — ver decisão 4 do plano):**

- `markPaid` originalmente só reivindicava o payment a partir de `pending`.
  Como o expirador/cancelamento move o payment para `expired`/`failed`/
  `cancelled` *antes* de um webhook tardio chegar, essa claim nunca via o
  pagamento real e o retorno `null` era silenciosamente absorvido pelo
  processor — dinheiro capturado, banco dizendo `expired`, nenhum sinal. A
  claim agora aceita `pending | expired | failed | cancelled`, então o
  pagamento tardio é sempre reconhecido como `succeeded`; a guarda de order
  (`pending_payment → paid`) continua intocada, então um pedido cancelado
  continua cancelado.
- Isso por si só não bastava: um log de `error` não é consultável depois do
  fato. Agora, sempre que o payment é confirmado `succeeded` mas o pedido
  **não** estava `pending_payment`, `markPaid` grava, na mesma transação, um
  `OutboxEvent` do tipo `payment.orphaned` com `{ orderId, paymentId }`. O
  relayOutbox loga isso como erro (sem email — é alerta de operação, não
  mensagem pro cliente) e marca `processed`; a linha em si já serve como fila
  de reembolsos manuais pendentes.
- `payment_intent.payment_failed` do Stripe **não é mais tratado como
  terminal**: ele dispara em toda tentativa recusada e o mesmo PaymentIntent
  pode ser retentado e ter sucesso depois. Só `payment_intent.canceled`
  cancela o pedido e devolve estoque; `payment_failed` apenas loga um `warn` e
  deixa o pedido `pending_payment` — o worker de expiração de 30 min continua
  sendo o único responsável por liberar a reserva.

## ADR-013: colunas `stripeAccountId`/`wooviPixKey` nascem no Plano 3 (nullable)

**Contexto:** lojas precisam configurar como receber pagamentos (Stripe ou
Woovi). Integração real de onboarding (Know Your Customer, vinculação de
contas) é trabalho do Plano 6.

**Decisão:** adicionar ao Store: `stripeAccountId: String | null` e
`wooviPixKey: String | null`. Checkout exige pelo menos um configurado
(`payments_not_configured` se ausente). Nenhum fluxo de preenchimento automático
neste plano.

**Consequências:** checkout pode validar permissão de pagamento sem chamar
webhook de onboarding. Plano 6 adiciona forms de autenticação e automação.
Lojas sem nenhum método configurado não conseguem vender (erro 400), o que é
intencional — força setup mínimo antes de aceitar pedidos.

## ADR-014: Encomenda é uma linha única por (produto, usuário), com notificação via outbox

**Contexto:** a spec demanda `product_interests` com status `open | notified |
converted | cancelled` e gestão com demanda agregada + aviso de chegada. Permitir
múltiplas linhas por par (produto, usuário) inflaria a demanda agregada (cliente
vê demanda de si mesmo contabilizada várias vezes) e abriria porta para spam;
mandar email de chegada **dentro do request** da loja travaria a resposta com
centenas de interesses e perderia entrega em caso de falha da rede/email antes da
resposta.

**Decisão:** unique constraint `(productId, userId)`; `POST /interests` é
idempotente e reabre linha existente em vez de criar nova (`upsertOpen` com
`update` setando `status: open, notifiedAt: null`); notificação de chegada
(`POST .../interests/notify`) grava `interest.notified` evento no outbox e o
worker `relayOutbox` processa de forma assíncrona, enviando email sem bloquear a
resposta; conversão automática (interesse vira compra após `order.paid`) rodam
dentro do mesmo relayOutbox via `updateMany` idempotente guardado por status
(`status: { in: ["open", "notified"] }`).

**Consequências:** demanda agregada é confiável por construção (uma linha por
par); cliente não consegue duplicar sua própria encomenda; reprocessar um evento
outbox é no-op (queries guardadas por status anterior); entrega de email é
durável mesmo se loja receber timeout (outbox retry a cada 10s por até 5
tentativas); o custo é que histórico de encomendas anteriores do mesmo par se
perde na reabertura — tradeoff aceito, pois clientes com necessidade de auditoria
completa têm os `Order`.
