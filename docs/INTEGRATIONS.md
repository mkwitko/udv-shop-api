# Integrações externas — udv-shop-api

Documentação das integrações com serviços de terceiros (APIs, webhooks,
credenciais).

## Stripe

Processamento de pagamento por cartão de crédito/débito via Stripe, com
suporte a **destination charges** (cobrança na conta de um parceiro com fee
aplicada na plataforma).

### Configuração

Variáveis de ambiente:
- `STRIPE_SECRET_KEY` — chave secreta da API Stripe (prefixo `sk_`). Obrigatória
  em produção. Gerar em [Stripe Dashboard → API Keys](https://dashboard.stripe.com/apikeys).
- `STRIPE_WEBHOOK_SECRET` — secret de verificação de webhooks (prefixo `whsec_`).
  Obrigatória em produção. Criar em Stripe Dashboard → Webhooks, copiar "Signing
  secret".
- `STRIPE_CONNECT_WEBHOOK_SECRET` — secret do endpoint de eventos de **conta
  conectada**. É um segundo endpoint no Dashboard (Webhooks → "Connect
  applications"), com signing secret próprio. Sem ele os eventos que nascem no
  núcleo (`account.updated`, ciclo de vida da doação mensal) falham na verificação
  de assinatura e são descartados. Obrigatória em produção.

### Contas conectadas

No **BR** as capabilities `card_payments` e `transfers` têm de ser pedidas juntas: com
`transfers` sozinho a Stripe recusa a criação com `You cannot request the 'transfers'
capability without the 'card_payments' capability for accounts in BR`, e o núcleo trava
no "configurar recebimento" com `BAD_GATEWAY payment_provider_error`.

Criadas com controller properties equivalentes a Express (sem o parâmetro `type`):
plataforma dona das perdas e das taxas, KYC coletado pela Stripe, dashboard Express.
Pré-requisito no Dashboard: aceitar a responsabilidade por perdas em
`settings/connect/platform-profile`, senão a criação é recusada. O núcleo acessa o
painel dele por login link de uso único (`POST /stores/:slug/connect/stripe/dashboard`),
não por `dashboard.stripe.com` — ver ADR-024.

### Fluxo

0. Pré-requisito: a loja precisa ter conta conectada **e** a capability `transfers`
   ativa (`store.stripeTransfersEnabled`). Em destination charge quem cobra é a
   plataforma; `charges_enabled` fala da conta do núcleo cobrar direto, que não é o
   nosso fluxo. Sem `transfers` o Stripe recusa a cobrança, então checkout e doação
   barram antes com `payments_not_configured`.
1. Checkout cria `PaymentIntent` via SDK (`stripe.paymentIntents.create`):
   - `amount`: total em centavos.
   - `currency`: "brl" (lowercase).
   - `automatic_payment_methods: { enabled: true }` — aceita cartão, Apple Pay, etc.
   - `application_fee_amount`: **omitido** quando a loja não tem comissão (ADR-027), que é
     o caso padrão; presente só se `applicationFeeBps > 0`.
   - `transfer_data: { destination: store.stripeAccountId }` — destino da grana.
   - `metadata: { orderId, paymentId }` — rastreamento.
2. Devolve `clientSecret` para o frontend completar no Payment Element.
3. Webhook POST a `/webhooks/stripe` quando pagamento muda de status.

### Eventos e webhook a configurar na Woovi

A Woovi aceita **um evento por webhook**, então são **três webhooks**, todos apontando
para a mesma URL `POST https://<api>/webhooks/woovi`:

| Evento | O que fazemos |
|--------|----------------|
| `OPENPIX:CHARGE_COMPLETED` | marca o pagamento pago e libera o pedido/doação |
| `OPENPIX:CHARGE_EXPIRED` | cancela o pendente e devolve o estoque |
| `OPENPIX:TRANSACTION_REFUND_RECEIVED` | marca reembolso (evento de **transação**, não de cobrança) |

A verificação usa o header `X-OpenPix-Signature`: HMAC-SHA1 do corpo cru em base64 com a
secret key **do webhook** (Admin → API/Plugins → clicar no webhook). Como a secret é por
webhook, `WOOVI_WEBHOOK_HMAC_SECRET` aceita os **três segredos separados por vírgula** —
qualquer um que assine o corpo vale. Com um segredo só, dois dos três eventos seriam
recusados como assinatura inválida.

A Woovi marca o HMAC como depreciado em favor de `x-webhook-signature` com a chave pública
deles — ainda funciona, mas é dívida conhecida.

### Doação mensal

Assinatura criada na conta da **plataforma** com `transfer_data.destination` para o núcleo
e `application_fee_percent`, sem `on_behalf_of` (ADR-025). O `Product` exigido pelo
`price_data` é um por loja (`Store.stripeDonationProductId`), reusado entre doações. Como
a assinatura SaaS da loja também vive na plataforma, o webhook separa as duas pelo lookup
do `subscriptionRef` nas doações — não por `event.account`.

### Eventos processados

- `payment_intent.succeeded` — extrai `metadata.paymentId`, chama `markPaid()`.
- `payment_intent.payment_failed` — cancela pedido e devolve estoque.
- `payment_intent.canceled` — idem acima.
- `charge.refunded` — marca payment como refundido.

### Webhook

- **Verificação:** Stripe envia header `stripe-signature` com timestamp e hash.
  `stripe.webhooks.constructEvent(rawBody, signature, secret)` valida ou lança.
- **Dois endpoints, dois secrets:** eventos da plataforma (assinatura SaaS) e eventos
  de conta conectada (`account.updated`, doação mensal) chegam por endpoints
  diferentes no Dashboard, cada um com signing secret próprio. O gateway tenta
  `STRIPE_WEBHOOK_SECRET` e depois `STRIPE_CONNECT_WEBHOOK_SECRET`, e só rejeita se
  nenhum assinar. `event.account` continua sendo o que separa a origem no
  processamento.
- **Raw body:** Fastify parser do escopo `webhooksRoutes` entrega buffer.
- **Dedup:** Stripe garante idempotência por `event.id` global.

### Refund

Chamado via `stripe.refunds.create({ payment_intent, reverse_transfer: true,
refund_application_fee: true })`. As duas flags não são opcionais em destination
charge: o dinheiro já foi para o núcleo quando a cobrança teve sucesso, e um refund
sem `reverse_transfer` sai inteiro do saldo da **plataforma** enquanto o núcleo fica
com a parte dele. `refund_application_fee` devolve também a taxa, que não faz sentido
manter numa venda que deixou de existir. Não devolve estoque nem reativa pedido (ver
ADR-012). Webhook `charge.refunded` confirma.

---

## Woovi

Processamento de pagamento via Pix (QR code, transferência instantânea) com
suporte a **split** (divisão automática entre plataforma e subconta do núcleo).

### Configuração

Variáveis de ambiente:
- `WOOVI_API_KEY` — **AppID** da Woovi, enviado cru no header `Authorization` (sem
  `Bearer`). É o base64 de `Client_Id_<uuid>:Client_Secret_<segredo>` — esse formato
  está **certo**, é assim que a Woovi monta o AppID. Gerar em Woovi Dashboard →
  API/Plugins.
- `WOOVI_BASE_URL` — `https://api.woovi.com` (produção) ou
  `https://api.woovi-sandbox.com` (teste). **O AppID é por ambiente**: chave gerada em
  `app.woovi-sandbox.com` responde `401 {"errors":[{"message":"appID inválido"}]}` em
  produção, e vice-versa. A mensagem é idêntica à de chave revogada, o que torna esse
  o erro mais fácil de diagnosticar errado.

  Diagnóstico (testa os dois ambientes e nunca imprime a chave inteira):

  ```bash
  npx tsx --env-file=.env scripts/woovi-check.ts
  WOOVI_TEST_KEY=<appid> npx tsx scripts/woovi-check.ts   # testar chave nova
  ```

  Só `401`/`appID inválido` é credencial errada. Um `400` de regra de negócio
  (`"Não foram encontradas subcontas para esta empresa"`) significa que a chave
  **autenticou** — é sinal de ambiente certo, não de falha.
- `WOOVI_WEBHOOK_HMAC_SECRET` — secret HMAC para assinatura de webhook.
  Obrigatória em produção. Criar em Woovi Dashboard → Webhooks.

### Subconta do núcleo

`PUT /stores/:slug/connect/woovi` cria a subconta na Woovi **antes** de gravar a chave
(`POST /api/v1/subaccount`) e guarda o identificador em `store.wooviSubaccountId`. A
cobrança depois divide por `splits[].pixKey` — quem manda no split é a **chave** — então
uma chave gravada sem subconta correspondente na Woovi faz a cobrança falhar.

Formato verificado contra a Woovi em 20/08/2026: subconta **não tem `id`**. O create
responde `{"subAccount":{"name","pixKey"}}` e a listagem
`{"subAccounts":[{"name","pixKey","withdrawBlocked","balance"}]}` — a chave Pix É o
identificador, e é por isso que `wooviSubaccountId` guarda a própria chave.

Com `DEV_FAKE_PAYMENTS=true` o gateway falso grava `fake_sub_<chave>` sem tocar na Woovi.
Ao desligar o modo falso, **re-salve a chave** na tela de Recebimento: é o que cria a
subconta de verdade e substitui o id falso.

Salvar a **mesma** chave é no-op (não cria subconta repetida). Trocar por outra saca o
saldo da subconta antiga primeiro — a Woovi só saca para a chave da própria subconta, e
depois da troca aquele saldo sairia da tela do núcleo. Se o saque estiver bloqueado, a
troca é recusada com `409 woovi_withdraw_blocked` em vez de esconder o dinheiro. A
subconta antiga fica vazia e não é apagada: um saque pedido segundos antes ainda pode
estar liquidando.

### Saldo é virtual — sem saque o dinheiro não sai daqui

Subconta **não é conta bancária**: o split reserva o valor dentro do saldo da conta da
plataforma, e ele só sai de verdade no saque
(`POST /api/v1/subaccount/{pixKey}/withdraw`, que leva **todo** o saldo). Sem essa
chamada, o Pix do núcleo fica na conta da plataforma para sempre.

Por isso o saque roda em dois lugares:

- **Automático:** cada `OPENPIX:CHARGE_COMPLETED` enfileira `woovi.withdraw` no outbox,
  que tem retry e claim atômico. Vai pelo outbox porque perder um saque é perder dinheiro
  de outra pessoa. Reprocessar é inofensivo: no pior caso a subconta já está zerada.
- **Manual:** `POST /stores/:slug/connect/woovi/withdraw` (owner), botão em Recebimento,
  para o que sobra — saldo preso por falha no automático ou entrado antes disso existir.

Respostas verificadas contra a Woovi em 20/08/2026:

| chamada | situação | resposta |
| --- | --- | --- |
| `GET /subaccount/{pixKey}` | existe | `{"subAccount":{name,pixKey,balance,withdrawBlocked}}` |
| `GET /subaccount/{pixKey}` | não existe | **`400`** `{"error":"Subconta não encontrada"}` — não 404 |
| `POST …/withdraw` | saldo zero | `400 {"error":"Not enought balance.  "}` |

Nenhum desses dois `400` é erro: saldo zero é o estado normal de quem já sacou, e chave
desconhecida acontece quando a chave gravada não existe mais lá. Tratá-los como falha
fazia a tela de Recebimento cair em `502` e o outbox gastar 5 tentativas por nada.

### Fluxo

1. Checkout cria `Charge` via POST `https://api.woovi.com/api/v1/charge`:
   ```json
   {
     "value": 5000,
     "correlationID": "payment.id",
     "expiresIn": 1800,
     "comment": "Pedido — Nome da Loja",
     "splits": [{
       "pixKey": "store.wooviPixKey",
       "value": 4750,
       "splitType": "SPLIT_SUB_ACCOUNT"
     }]
   }
   ```
   - `value`: total em centavos.
   - `correlationID`: nosso `payment.id` (chave de idempotência do lado deles).
   - `expiresIn`: 1800s (30 min, matches TTL).
   - `splits`: array com um objeto; `value` = total − fee (plataforma retém fee).
     `splitType: SPLIT_SUB_ACCOUNT` é obrigatório pra contas de subconta.
2. Resposta contém `brCode` e `qrCodeImage` (QR Code em base64 ou URL).
3. Cliente escaneia ou copia brCode e faz Pix.
4. Webhook POST a `/webhooks/woovi` quando status muda.

### Eventos processados

- `OPENPIX:CHARGE_COMPLETED` — pagamento recebido, chama `markPaid()`.
- `OPENPIX:CHARGE_EXPIRED` — prazo venceu sem pagamento, cancela pedido.
- `OPENPIX:TRANSACTION_REFUND_RECEIVED` — reembolso confirmado.

### Webhook

- **Verificação:** Woovi envia header `x-openpix-signature` com HMAC-SHA1
  base64 do raw body. Validado via `crypto.timingSafeEqual()` em
  `WooviGateway.verifyWebhook()`.
- **Raw body:** parser do escopo `webhooksRoutes` entrega buffer.
- **Dedup:** Woovi não tem event ID global; construímos
  `eventId = "${event}:${charge.correlationID}"` manualmente.

### Refund

Chamado via POST `https://api.woovi.com/api/v1/charge/{correlationID}/refund`:
```json
{
  "correlationID": "refund-uuid"
}
```
- `correlationID`: UUID nosso pra idempotência (Woovi rastreia por isso).
- Webhook `OPENPIX:TRANSACTION_REFUND_RECEIVED` confirma.

---

## Email transacional (Resend)

Envio de emails de confirmação de pagamento via Resend.

### Configuração

Variáveis de ambiente:
- `RESEND_API_KEY` — token de autenticação Resend. Obrigatória em produção.
- `EMAIL_FROM` — endereço remetente (ex.: `"Lojinha <nao-responda@example.org>"`).
  Deve ser domínio verificado em Resend.

### Fluxo

Worker `relayOutbox` processa eventos `order.paid` e chama `email.send()`:
- **Para:** email do usuário.
- **Subject:** "Pagamento confirmado — [Nome da Loja]".
- **Body:** HTML com confirmação de pedido, lista de itens, total e mensagem
  de contato.

Falhas (SMTP down, limite de rate) incrementam tentativas; após 5, marca evento
como `failed` (análise manual).

---

## Google OAuth

Autenticação federada via Google.

### Configuração

Variáveis de ambiente:
- `GOOGLE_CLIENT_ID` — client ID da credencial OAuth Google. Obrigatória em
  produção.
- `GOOGLE_CLIENT_SECRET` — client secret. Obrigatória em produção.
- `GOOGLE_REDIRECT_URI` — callback URL (ex.:
  `http://localhost:3333/auth/google/callback` local,
  `https://api.exemplo.com/auth/google/callback` produção).

Credencial criada em [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).

### Fluxo

Ver documentação de auth; integração Google já existente (Plano 1).

---

## Cloudflare R2

Cloud storage (S3-compatible) para imagens de produto.

### Configuração

Variáveis de ambiente:
- `R2_ACCOUNT_ID` — Cloudflare Account ID (copiar de R2 dashboard).
- `R2_ACCESS_KEY_ID` — API token ID. Gerar em Cloudflare → R2 → API Tokens.
- `R2_SECRET_ACCESS_KEY` — API token secret.
- `R2_BUCKET` — nome do bucket (ex.: `"udvshop-prod"`).
- `R2_PUBLIC_BASE_URL` — URL pública de leitura (ex.:
  `https://cdn.exemplo.com`). Importante: **sem trailing slash**.

### Fluxo

Ver documentação de upload; integração R2 já existente (Plano 1).

### Assinatura da plataforma (SaaS) criada fora do fluxo

A plataforma amarra assinatura → loja por `metadata.storeId` na Subscription (posto pelo
checkout em `create-billing-checkout`) ou pelo `stripeSubscriptionId` já gravado em
`StoreSubscription`. **Assinatura criada à mão no Dashboard não tem nenhum dos dois**:
`applySubscriptionEvent` não acha a loja e ignora o evento em silêncio. Para adotar uma,
grave `metadata.storeId = <uuid da loja>` na Subscription — o próximo
`customer.subscription.updated` já sincroniza.

### Webhook em desenvolvimento

A Stripe não alcança `localhost`. O encaminhamento é:

```bash
KEY=$(grep -m1 '^STRIPE_SECRET_KEY=' .env | cut -d= -f2-)
stripe listen --api-key "$KEY" \
  --forward-to localhost:3333/webhooks/stripe \
  --forward-connect-to localhost:3333/webhooks/stripe
```

Os dois `--forward*` apontam para a **mesma** rota de propósito: `verifyWebhook` tenta os
dois segredos e aceita o que assinar, então um endpoint serve os dois streams.

`--api-key` não é opcional. Sem ele o CLI escuta a conta do `stripe login` — que pode ser
outra que não a do `STRIPE_SECRET_KEY` — e **nenhum evento aparece**, sem erro nenhum: o
log do `listen` fica em silêncio. O sinal é o signing secret impresso mudar quando você
passa `--api-key`. Copie esse `whsec_` para `STRIPE_WEBHOOK_SECRET` (ele é estável por
conta + máquina) e reinicie a API, senão a assinatura falha com `invalid_signature`.

Detalhe ao testar à mão: `subscriptions.update` com metadata **idêntica** não gera evento.
Mude algum valor (um timestamp resolve) para a Stripe emitir `customer.subscription.updated`.

---

## Cloudflare Workers AI

Escreve e melhora a descrição de produto no `/gestao` (botão "Escrever com IA" /
"Melhorar com IA"). Rota: `POST /stores/:slug/products/description-suggestion`
(`suggestProductDescription`), 10 req/min, permissão de staff da loja. A rota só
devolve texto — nunca grava: quem aplica é a loja.

### Configuração

- `CF_AI_ACCOUNT_ID` — Account ID Cloudflare. Se vazio, cai em `R2_ACCOUNT_ID`
  (é a mesma conta).
- `CF_AI_API_TOKEN` — API token com permissão **Workers AI: Read** na conta.
  Gerar em Cloudflare → My Profile → API Tokens.
- `CF_AI_MODEL` — padrão `@cf/meta/llama-4-scout-17b-16e-instruct`.
  Comparado em 2026-08-19 com llama-3.3-70b (bom, ~2x mais rápido), qwen2.5-coder
  (inventou "artesãos locais" — fato novo) e mistral-small ("Cabele 300 mililitros").
  O scout escreve o melhor português nos dois modos, em ~2,4s.

Vazio desliga a feature: a rota responde `503 ai_not_configured` e a tela esconde
os botões. Cota diária estourada vira `503 ai_quota_exceeded` — cadastrar produto
continua funcionando sem IA.

---

## Resumo de env (checkout + webhooks)

Após habilitar checkout Stripe/Woovi:

```bash
# Stripe
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...

# Woovi
WOOVI_API_KEY=...
WOOVI_WEBHOOK_HMAC_SECRET=...
```

Todas são strings vazias `""` por padrão (desenvolvimento local); todas são
obrigatórias em produção (`requiredNonEmpty` no env schema).
