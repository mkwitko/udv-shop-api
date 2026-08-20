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

## ADR-015: pagamento é polimórfico e o roteamento decide o agregado antes de reivindicar

**Contexto:** doações de campanhas, assim como pedidos, criam pagamentos que
podem ser confirmados por webhook (Stripe ou Woovi). Diferentemente de pedidos,
uma doação pode estar vinculada a uma subscrição mensal, que afeta como a
cobrança é feita e como o webhook é processado.

**Decisão:** ao processar webhook de pagamento confirmado, **não** usar
`payment.orderId` ou similar para descobrir qual agregado (Order, Donation)
reivindicou o pagamento. Em vez disso, roteador (`markPaid()`, `cancelPaid()`)
examina campos do payload do webhook ou consulta a tabela `Payment` para
descobrir o tipo de raiz (Order ou Donation) e chama o service apropriado
(`markOrderPaid()` vs. `markDonationPaid()`). O service de cada agregado
nunca compartilha repositório de pagamento — `webhook-processor` (que não
conhece domínio de Order ou Donation) valida e persiste evento, e o roteador
entrega a cada agregado pela chave correta.

**Consequências:** webhook-processor é agnóstico (evita acoplamento). Cada
agregado controla como seus pagamentos transitam (Order: `pending_payment → paid`;
Donation: `pending_payment | pending_invoice → paid`). Bug evitado: versão
anterior poderia marcar um payment de doação como pertencendo a um Order se
IDs coincidissem ou lógica de discovery fosse ambígua — agora o roteamento é
explícito e cada agregado valida o domínio.

## ADR-016: doação mensal usa direct charge na conta conectada — SUPERSEDED pelo ADR-025

**Contexto:** Stripe Billing (para subscrições) exige que a conta conectada
receba a cobrança diretamente (`direct charge`), com fee como percentual
(`application_fee_percent`) da invoice. Doação única (checkout de uma vez) é
cobrável via `destination charge` (fee lump-sum em `application_fee_amount`).

**Decisão:** (1) `Donation` sem `subscriptionId` (única): usar `stripe.paymentIntents.create`
com `transfer_data.destination = store.stripeAccountId` +
`application_fee_amount`. (2) `Donation` com `subscriptionId` (mensal): usar
Stripe Billing Subscription, invoice é criada na conta conectada, fee é
`application_fee_percent` configurado globalmente. Webhook chega como
`invoice.payment_succeeded` em conexão Connect.

**Consequências:** (a) Doação mensal requer nova verificação de evento
(`subscription_create`, `subscription_cycle`, `invoice.*` em domínio Connect).
(b) Webhook é processado no endpoint `/webhooks/stripe` mas a validação de
`stripe-account` header deve confirmar conta original (plataforma), não
subconta. (c) Fee de doação mensal é percentual da invoice (ex.: 2%) vs.
lump-sum de doação única (ex.: 100 centavos) — contabilidade deve separar
as duas linhas. (d) Stripe Billing cria a invoice e agenda re-tentativas
automaticamente; nós não controlamos isso (Stripe decide quantas vezes tenta,
por quantos dias).

## ADR-017: sorteio determinístico com seed publicada no draw

**Contexto:** sorteio de prêmios de campanha exige auditabilidade — doador,
loja e terceiros precisam conseguir verificar que o vencedor foi escolhido
sem fraude. Uma opção é pré-gerar a seed; outra é gerá-la no momento do draw
e publicá-la.

**Decisão:** seed é gerada **no momento do draw**, nunca antes. Admin chama
`POST /campaigns/:id/raffles/:raffleId/draw`, API sorteia UUID como seed,
persiste em `RaffleResult` junto com `algorithm: "sha256-counter-v1"`,
`drawnAt` e `winnerNumberGranted`. Auditor externo (incluindo doador) consegue
validar recalculando `sha256(seed + ":" + [cada número da campanha])` e
confirmando que o vencedor é o que a API reportou.

**Consequências:** (a) Seed não é pré-persistido — impossível admin sortear,
não gostar, sortear novamente sem deixar rastro. (b) Segurança criptográfica:
usuário não consegue adivinhar seed antes da transação ser confirmada (256
bits, infeasível em força bruta — pelo menos ~2^128 tentativas). (c)
Transparência pública: loja fornece seed + lista de números para auditoria
comunitária (similar a loterias blockchain, mas com garantia de plataforma).
(d) **Risco jurídico** (§ 11 da spec): validação de conformidade regulatória
(CVM, prêmios sujeitos a tributação/auditoria) precisa acontecer **antes** de
ativar sorteio em produção — ADR apenas documenta como é implementado,
não resolve conformidade.

## ADR-018: identidade do doador é da gestão; vitrine pública só vê nome mascarado

**Contexto:** leaderboard / vitrine de doadores (nomes e valores) é apelo de
marketing de campanha (social proof). Porém, publicar nome completo + valor
doado expõe identidade de pessoas que talvez prefira anonimato. Mesma questão
para vencedor de sorteio.

**Decisão:** toda rota pública que retorna identidade de doador (GET
`/campaigns/:id/donations`, `POST .../draw/winner`) passa por
`maskName(donorName)`: transforma `"João da Silva"` → `"J. Silva"` (inicial +
sobrenome, sem números/CPF/dados financeiros). Donor anônimo (`anonymousName`)
continua anônimo (`"Anônimo"`). **Vencedor é sempre mascarado**, mesmo que
tenha doado como pessoa nomeada — evita que sortear "Vitória Silva" revele
que ela tem interesse público em campanha de saúde/política/religião.

Dados completos (`fullName`) ficam em `Admin` (owner/staff de loja, plataforma_admin):
`GET /admin/campaigns/:id/donations?limit=100` devolve nomes completos em `admin`
scope. Cliente (owner da doação) vê seu próprio nome completo em
`GET /donations/mine`.

**Consequências:** (a) Balanceamento de confiança: doador vê seu próprio nome
inteiro (conforto de verificação); público vê máscara (privacidade). (b) Admin
da loja consegue contato completo para agradecimento privado. (c) Tabelas de
liderança / trending são honestas (nomes mascarados), evitando viés de nome
real que prejudicaria anonimato. (d) Testes de vazamento (`no applicationFee*
in response` etc) precisam cobrir também resposta de sorteio e vitrine de
doadores.

**Ajuste (implementação):** as duas superfícies públicas do sorteio aplicam a
mesma regra — `GET .../raffle` (vencedores) e `GET .../raffle/entries` chamam
`maskName(nome, donation.anonymous)`. Quem doou anônimo aparece como
`"Doador anônimo"` também quando é sorteado; antes o vencedor era mascarado por
nome (`"Maria S."`) enquanto a lista de entradas já o tratava como anônimo.
Entregar o prêmio é responsabilidade da gestão, que enxerga identidade completa
em `GET /stores/:slug/donations`.

## ADR-019: assinatura SaaS mora na conta da plataforma, separada do dinheiro do núcleo

**Contexto:** a plataforma tem duas relações financeiras com o núcleo, e elas são
opostas. Na venda e na doação, o dinheiro é do núcleo e a plataforma tira uma
comissão (`application_fee`). Na assinatura SaaS, o dinheiro é da plataforma e o
núcleo é o cliente. Misturar as duas na mesma conta Stripe embaralharia
conciliação, relatório fiscal e reembolso.

**Decisão:** a assinatura SaaS é um Checkout Session em modo `subscription` criado
**sem** `stripeAccount` — na conta da plataforma, sem `application_fee`, com o
`storeId` viajando em `metadata` e em `subscription_data.metadata`. O estado vive em
`StoreSubscription` (`@unique` em `storeId`), tabela separada de `Payment`, que
continua sendo só de pedido e doação.

**Consequências:** (a) o `Payment` polimórfico do ADR-015 não precisou de um terceiro
dono; (b) o portal do Stripe pode ser aberto para o núcleo gerir o próprio cartão sem
dar acesso a nada do fluxo de doação; (c) a plataforma precisa de webhook da própria
conta *e* das conectadas no mesmo endpoint — ver ADR-021.

## ADR-020: Connect standard, não express — SUPERSEDED pelo ADR-024

**Contexto:** Connect oferece `standard`, `express` e `custom`. Muda quem é dono da
relação com o Stripe: obrigações fiscais, disputas, suporte, e quem vê qual dashboard.

**Decisão:** contas `standard`. O núcleo cria (ou conecta) uma conta Stripe própria, com
dashboard próprio, e é ele quem responde por disputa e obrigação fiscal. A plataforma
faz destination charge com `application_fee` e nada mais.

**Consequências:** (a) o onboarding é mais pesado para o núcleo (CNPJ, dados bancários —
risco já registrado na §11 da spec) e a plataforma não pode preencher os dados por ele;
(b) em compensação, a plataforma não vira responsável solidária por disputa de cartão de
uma loja; (c) o núcleo pode ver e reembolsar as próprias cobranças pelo dashboard do
Stripe, fora do nosso sistema — os webhooks nos mantêm em dia quando isso acontece.

**Revisão (2026-08-18):** a consequência (b) estava errada. Na tabela da Stripe, a conta
Standard responde por fraude e disputa apenas em *direct charge*; em **destination
charge**, que é o nosso fluxo, quem responde é a plataforma. Standard nunca nos protegeu
disso — só nos deixou numa configuração que a Stripe lista como a evitar. Ver ADR-024.

## ADR-021: o campo `account` do evento é o que separa Connect da plataforma

**Contexto:** `/webhooks/stripe` é um endpoint só, e recebe eventos da conta da
plataforma e de todas as contas conectadas. Vários tipos existem nos dois mundos com
significados opostos: `customer.subscription.deleted` é "um doador cancelou a doação
mensal" quando vem do núcleo e "a loja parou de pagar a plataforma" quando vem da
plataforma. `invoice.paid` idem.

**Decisão:** o payload inteiro do evento é persistido, e o roteamento lê `event.account`,
presente só quando o evento nasce numa conta conectada. Ramos de doação exigem `account`
presente; ramos de billing exigem ausente. Cobrança de pedido e doação única são
*destination charges*, criadas na conta da plataforma, e continuam chegando sem `account` —
nada mudou para elas.

**Consequências:** (a) o endpoint precisa estar registrado com `connect: true` no Stripe,
senão os eventos das contas conectadas simplesmente não chegam e a doação mensal para de
funcionar em silêncio; (b) os testes de doação mensal passaram a mandar `account` no
evento, como o Stripe faz — um teste que omita o campo agora testa o ramo errado;
(c) `account.updated` não precisa do gate, porque só existe no mundo Connect e é
resolvido pelo `stripeAccountId` (`@unique`) da loja.

## ADR-022: repasse a parceiro é registro contábil, não divisão de pagamento

**Contexto:** boa parte dos produtos de um núcleo é feita por outra pessoa — a artesã
costura, a loja vende, e depois alguém precisa lembrar quanto devolver. A tentação é
dividir o pagamento no gateway (Stripe Connect transfer, split Woovi por chave).

**Decisão:** o dinheiro continua caindo inteiro na conta da loja. O repasse é registrado:
o acordo fica no produto, o valor é congelado no `OrderItem` da venda, e o saldo é
derivado (vendas pagas − repasses registrados). A loja paga por fora (Pix, dinheiro) e
registra o pagamento.

**Consequências:** (a) nenhum parceiro precisa abrir conta Stripe nem passar por KYC — a
feature funciona no dia um, para quem vende feira e bazar; (b) a plataforma não vira
intermediária de pagamento a terceiro, o que traria obrigação regulatória que hoje ela não
tem; (c) em troca, o repasse depende da loja registrar o que pagou — é um livro-caixa
honesto, não uma garantia; (d) reembolso depois de repasse pago aparece como saldo
negativo (crédito), em vez de exigir estorno do parceiro; (e) se um dia o split real for
necessário, o `OrderItem.payoutCents` já é o número que o transfer usaria.

## ADR-023: domínio próprio é reescrita no servidor do front, não redirect

**Contexto:** uma loja com endereço próprio (`loja.comunidade.org`) precisa servir as
mesmas páginas que `/loja/{slug}`. Redirect resolveria em uma linha, mas o endereço da
comunidade sumiria da barra no primeiro clique — que é justamente o ponto de ter um.

**Decisão:** o worker do front (`src/server.ts`) resolve o Host pela API
(`/stores/by-domain`, cache de 60s em memória) e **reescreve** o caminho para
`/loja/{slug}{path}` antes de entregar ao roteador. Host da plataforma, arquivo com
extensão e chamada de server function passam intactos. API fora do ar ou host
desconhecido: nada é reescrito e o visitante cai na landing.

**Consequências:** (a) nenhuma rota nova, nenhum componente duplicado — o app inteiro
funciona no domínio da loja sem saber disso; (b) `wrangler.jsonc` passou a apontar
`main` para `src/server.ts`, senão o Vite ignora a entrada customizada; (c) o TLS do
domínio da loja depende de **Cloudflare for SaaS** (custom hostnames), que é pago e
precisa de token de zona — a aplicação está pronta, a conta ainda não; (d) verificação
por CNAME não é permanente: a próxima verificação desfaz se o registro sair do ar.

## ADR-024: conta conectada com controller properties de Express, não `type` legado

**Contexto:** o ADR-020 escolheu `type: "standard"` acreditando que isso tirava a
plataforma da linha de frente das disputas. Não tira: em destination charge — o nosso
fluxo — a cobrança nasce na conta da plataforma, e é o saldo dela que o refund e a
disputa debitam. A configuração Standard (Stripe dona das perdas, núcleo pagando as
taxas, dashboard completo) é justamente a que a Stripe lista como "a evitar" para
destination charge, e a tabela oficial dá Standard como suportando direct charge apenas.

**Decisão:** criar contas sem o parâmetro `type`, com controller properties equivalentes
a Express: `losses.payments: application`, `fees.payer: application`,
`requirement_collection: stripe`, `stripe_dashboard.type: express`, pedindo a capability
`transfers`. `losses.payments: application` obriga `fees.payer: application` — as duas
andam juntas. Não fomos para Accounts v2 porque, no preview, destination charge exige
`on_behalf_of`, o que faria do núcleo o *settlement merchant* — exatamente o que a
orientação de Marketplace proíbe; a própria doc manda usar v1 com controller properties
quando v2 não cobre o caso.

**Consequências:** (a) a plataforma precisa aceitar a responsabilidade por perdas no
platform profile do Dashboard antes de criar qualquer conta nova — sem isso a criação é
recusada; (b) o núcleo perde o dashboard completo do Stripe e passa a entrar por login
link de uso único (`POST /stores/:slug/connect/stripe/dashboard`), o que também significa
que ele não reembolsa mais por fora do nosso sistema; (c) a plataforma passa a ser
formalmente dona do risco, então Radar for Platforms deixa de ser opcional; (d) a Stripe
não converte o tipo de uma conta existente: migrar é criar conta nova e refazer o
onboarding, guardando o id antigo em `metadata.migrated_from_account_id`.

## ADR-025: doação mensal também é destination charge na plataforma

**Contexto:** o ADR-016 pôs a assinatura de doação como direct charge dentro da conta do
núcleo, enquanto pedido e doação única seguiam destination charge na plataforma. A mesma
loja passava a ter dois merchants of record: relatório e conciliação partidos, disputa
seguindo regra diferente conforme o tipo de doação, e a elegibilidade de método de
pagamento (é assim que o Pix entra ou não) decidida pelo país de um MoR diferente. O
refund do ciclo mensal também não passava pelo caminho de `reverse_transfer`.

**Decisão:** a assinatura de doação nasce na conta da plataforma, com
`transfer_data.destination` apontando para o núcleo e `application_fee_percent` como
taxa. Sem `on_behalf_of` — ele faria do núcleo o *settlement merchant*, exatamente o que a
orientação de Marketplace proíbe; e como plataforma e núcleos estão todos no BR, não
caímos na exceção cross-border que obrigaria o parâmetro. O `Product` exigido pelo
`price_data` passa a ser um por loja (`Store.stripeDonationProductId`), reusado, em vez de
um por doação.

**Consequências:** (a) assinatura de doação e assinatura SaaS da loja passam a viver na
mesma conta e a compartilhar os mesmos tipos de evento — `payload.account` não separa mais
nada, e quem separa é o lookup do `subscriptionRef` na tabela de doações
(`isDonationSubscription`); sem isso o cancelamento de uma doação derrubaria a assinatura
da loja, e é o primeiro caso coberto por teste; (b) cancelar assinatura deixa de precisar
saber a conta conectada da loja; (c) a Stripe não move subscription entre contas: as
assinaturas antigas (nenhuma viva quando isto foi feito) não migram — teriam que ser
canceladas e refeitas.

## ADR-026: onboarding e avisos da Stripe embutidos no /gestao

**Contexto:** com contas Express (ADR-024) o núcleo perdeu o dashboard completo, e o
onboarding hospedado tira a pessoa do nosso app no momento mais frágil do cadastro. Pior:
requisito novo que a Stripe passa a exigir depois do onboarding não aparece em lugar nenhum
para o núcleo — a conta é desabilitada e a loja para de vender sem explicação.

**Decisão:** Account Sessions (`POST /stores/:slug/connect/stripe/account-session`, só
owner) e Connect embedded components no front, com `account_onboarding` e
`notification_banner`. O banner fica sempre montado quando existe conta; o formulário
aparece quando o núcleo pede. O link hospedado continua como fallback para ambiente sem
chave publicável configurada.

**Consequências:** (a) o client secret é credencial de curta duração de um núcleo só —
nunca cacheado no front, e cada renovação passa de novo pela nossa rota, que reavalia
permissão; (b) a aparência só muda pelos tokens que a Stripe expõe (`colorPrimary`,
`colorBackground`, `colorText`, `colorDanger`, `fontFamily`, `borderRadius`) e é preciso
chamar `update({ appearance })` na troca de tema, senão o componente fica claro dentro da
página escura; (c) a rota cria a conta conectada na primeira chamada, então o componente só
é montado quando já existe conta ou quando o núcleo pede o cadastro — montar sozinho
criaria conta para quem nunca pediu; (d) o login link Express segue existindo para o painel
completo de recebimentos.

## ADR-027: a plataforma cobra mensalidade, não comissão por venda

**Contexto:** o modelo era comissão de 5% (`applicationFeeBps` 500) por venda, mais a
assinatura SaaS. Com destination charge e `fees.payer: application` (ADR-024), quem paga a
taxa de processamento do Stripe é a **plataforma**. Fazendo a conta: numa venda de R$ 50 no
cartão, a comissão de 5% dá R$ 2,50 e o custo do Stripe fica em torno de R$ 2,39 — sobra
R$ 0,11. A comissão no cartão era praticamente repasse de custo, não receita, e ainda
custava a explicação de "taxa por venda" para o núcleo.

**Decisão:** comissão zero. `Store.applicationFeeBps` passa a ter default 0, e as lojas
existentes foram zeradas na migração. A receita da plataforma é a mensalidade da loja
(Stripe Billing, price de R$ 199/mês por enquanto). Onde a comissão é zero, os campos
`application_fee_amount` e `application_fee_percent` são **omitidos** da chamada em vez de
mandados zerados: fee zero explícita cria ApplicationFee de R$ 0 em todo pagamento e suja
o relatório sem significar nada.

**Consequências:** (a) o campo continua existindo por loja, então voltar a cobrar comissão
(inclusive para uma loja só) é mudar um número, sem migração; (b) a plataforma passa a
absorver integralmente o custo de processamento: no cartão, uma loja fica no zero a zero
por volta de R$ 4.700 de GMV/mês (R$ 199 ÷ ~4,2%); acima disso a mensalidade não cobre mais
o custo daquela loja, e o modelo precisa ser revisto — Pix, muito mais barato, empurra esse
limite para muito mais alto; (c) a tela de recebimento diz que não há taxa por venda, em
vez de exibir "0%".
