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

### Fluxo

1. Checkout cria `PaymentIntent` via SDK (`stripe.paymentIntents.create`):
   - `amount`: total em centavos.
   - `currency`: "brl" (lowercase).
   - `automatic_payment_methods: { enabled: true }` — aceita cartão, Apple Pay, etc.
   - `application_fee_amount`: fee em centavos.
   - `transfer_data: { destination: store.stripeAccountId }` — destino da grana.
   - `metadata: { orderId, paymentId }` — rastreamento.
2. Devolve `clientSecret` para o frontend completar no Payment Element.
3. Webhook POST a `/webhooks/stripe` quando pagamento muda de status.

### Eventos processados

- `payment_intent.succeeded` — extrai `metadata.paymentId`, chama `markPaid()`.
- `payment_intent.payment_failed` — cancela pedido e devolve estoque.
- `payment_intent.canceled` — idem acima.
- `charge.refunded` — marca payment como refundido.

### Webhook

- **Verificação:** Stripe envia header `stripe-signature` com timestamp e hash.
  `stripe.webhooks.constructEvent(rawBody, signature, secret)` valida ou lança.
- **Raw body:** Fastify parser do escopo `webhooksRoutes` entrega buffer.
- **Dedup:** Stripe garante idempotência por `event.id` global.

### Refund

Chamado via `stripe.refunds.create({ payment_intent: providerId })`. Não
devolve estoque nem reativa pedido (ver ADR-012). Webhook `charge.refunded`
confirma.

---

## Woovi

Processamento de pagamento via Pix (QR code, transferência instantânea) com
suporte a **split** (divisão automática entre plataforma e subconta do núcleo).

### Configuração

Variáveis de ambiente:
- `WOOVI_API_KEY` — token de autenticação Woovi. Enviado como header
  `Authorization`. Obrigatória em produção. Gerar em [Woovi Dashboard → API](https://app.woovi.com).
- `WOOVI_WEBHOOK_HMAC_SECRET` — secret HMAC para assinatura de webhook.
  Obrigatória em produção. Criar em Woovi Dashboard → Webhooks.

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
- `OPENPIX:CHARGE_REFUND` — reembolso confirmado.

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
- Webhook `OPENPIX:CHARGE_REFUND` confirma.

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

---

## Resumo de env (checkout + webhooks)

Após habilitar checkout Stripe/Woovi:

```bash
# Stripe
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Woovi
WOOVI_API_KEY=...
WOOVI_WEBHOOK_HMAC_SECRET=...
```

Todas são strings vazias `""` por padrão (desenvolvimento local); todas são
obrigatórias em produção (`requiredNonEmpty` no env schema).
