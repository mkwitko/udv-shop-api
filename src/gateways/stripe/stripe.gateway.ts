import Stripe from "stripe";
import { badGateway, ConflictError } from "../../shared/errors.js";

export type StripeWebhookEvent = {
  id: string;
  type: string;
  // Presente só quando o evento nasce numa conta conectada. É o que separa a cobrança
  // do núcleo (Connect) da assinatura SaaS da plataforma, que compartilham tipos de
  // evento como customer.subscription.deleted — ver ADR-021.
  account?: string;
  data: { object: Record<string, unknown> };
};

export type CreatePaymentIntentInput = {
  amountCents: number;
  currency: string;
  metadata: Record<string, string>;
};

export type RefundInput = {
  providerId: string;
  /** Transfer do repasse. `null` = o repasse ainda não saiu, não há o que reverter. */
  transferId: string | null;
  /** Líquido que foi repassado — é ele que volta, não o bruto. */
  netCents: number;
  idempotencyKey: string;
};

export type CreateTransferInput = {
  amountCents: number;
  currency: string;
  destinationAccountId: string;
  /** Charge de origem: é ela que libera o dinheiro, em vez do saldo da plataforma. */
  chargeId: string;
  idempotencyKey: string;
};

export type CreateDonationSubscriptionInput = {
  amountCents: number;
  currency: string;
  customerEmail: string;
  productName: string;
  /** Product da plataforma reusado entre doações da mesma loja; null cria um novo. */
  productId: string | null;
  metadata: Record<string, string>;
};

export type ConnectedAccountStatus = {
  /** Capability `transfers` ativa: é ela que permite a destination charge chegar no núcleo. */
  transfersEnabled: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
};

export type CreateSaasCheckoutInput = {
  priceId: string;
  customerId: string | null;
  customerEmail: string;
  storeId: string;
  successUrl: string;
  cancelUrl: string;
};

export interface StripeGateway {
  createPaymentIntent(
    input: CreatePaymentIntentInput,
  ): Promise<{ providerId: string; clientSecret: string }>;
  refundPaymentIntent(input: RefundInput): Promise<{ reversalFailed: boolean }>;
  retrieveChargeFee(
    chargeId: string,
  ): Promise<{ amountCents: number; feeCents: number; currency: string }>;
  createTransfer(input: CreateTransferInput): Promise<{ transferId: string }>;
  reverseTransfer(input: {
    transferId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<void>;
  /** Charge que pagou a fatura, ou null se a fatura não gerou cobrança. */
  retrieveInvoiceChargeId(invoiceId: string): Promise<string | null>;
  createDonationSubscription(
    input: CreateDonationSubscriptionInput,
  ): Promise<{ subscriptionId: string; clientSecret: string; productId: string }>;
  cancelSubscription(subscriptionId: string): Promise<void>;
  createConnectedAccount(input: {
    email: string;
    storeName: string;
  }): Promise<{ accountId: string }>;
  createAccountLink(input: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
  createExpressDashboardLink(accountId: string): Promise<{ url: string }>;
  createAccountSession(accountId: string): Promise<{ clientSecret: string }>;
  retrieveAccountStatus(accountId: string): Promise<ConnectedAccountStatus>;
  createSaasCheckoutSession(
    input: CreateSaasCheckoutInput,
  ): Promise<{ url: string; sessionId: string }>;
  createBillingPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
  verifyWebhook(rawBody: Buffer, signature: string): StripeWebhookEvent;
}

/**
 * O Stripe recusa a conta de destino quando o id não existe mais (ou nunca existiu).
 * Isso é problema do Connect DAQUELA loja, não da plataforma: 502 mandava o time procurar
 * pane de infraestrutura enquanto a correção era refazer o onboarding.
 */
function stripeFailure(err: unknown): Error {
  const code = (err as { code?: string } | null)?.code;
  if (code === "account_invalid") return new ConflictError("store_stripe_account_invalid");
  return badGateway("payment_provider_error", err);
}

export function createStripeGateway(cfg: {
  secretKey: string;
  webhookSecret: string;
  connectWebhookSecret?: string;
  connectCountry?: string;
}): StripeGateway {
  let client: Stripe | null = null;
  const stripe = () => {
    // Pinned explicitly: an unpinned client tracks the SDK's default version across
    // dependency upgrades, and the webhook payload shapes this file destructures
    // (data.object.metadata, data.object.payment_intent) are version-dependent.
    client ??= new Stripe(cfg.secretKey, { apiVersion: "2026-07-29.dahlia" });
    return client;
  };
  return {
    async createPaymentIntent(input) {
      // Separate charges and transfers (ADR-029): a cobrança nasce inteira na plataforma,
      // SEM `transfer_data`. O repasse sai depois, já descontada a taxa real que o
      // `balance_transaction` só revela quando a cobrança é aprovada — `transfer_data` e
      // `application_fee_amount` são fixados aqui, quando essa taxa ainda não existe.
      // Sem `on_behalf_of`: a plataforma continua sendo o merchant of record (ADR-025).
      const intent = await stripe()
        .paymentIntents.create({
          amount: input.amountCents,
          currency: input.currency.toLowerCase(),
          automatic_payment_methods: { enabled: true },
          metadata: input.metadata,
        })
        .catch((err: unknown) => {
          throw stripeFailure(err);
        });
      if (!intent.client_secret) throw new Error("stripe_missing_client_secret");
      return { providerId: intent.id, clientSecret: intent.client_secret };
    },
    async retrieveChargeFee(chargeId) {
      try {
        const charge = await stripe().charges.retrieve(chargeId, {
          expand: ["balance_transaction"],
        });
        const txn = charge.balance_transaction;
        // String aqui significa que o expand não veio. Assumir taxa zero repassaria o bruto
        // e a plataforma pagaria a taxa em silêncio — o oposto da decisão.
        if (!txn || typeof txn === "string") {
          throw new Error("stripe_balance_transaction_not_expanded");
        }
        return { amountCents: charge.amount, feeCents: txn.fee, currency: charge.currency };
      } catch (err) {
        throw badGateway("payment_provider_error", err);
      }
    },
    async createTransfer(input) {
      try {
        // `source_transaction` amarra o repasse à cobrança que o financia: sem ele o Stripe
        // saca do saldo disponível da plataforma, e um dia de volume alto derruba tudo em
        // `balance_insufficient`. A chave de idempotência vem do pagamento: reprocessar o
        // evento de outbox não pode repassar duas vezes.
        const transfer = await stripe().transfers.create(
          {
            amount: input.amountCents,
            currency: input.currency.toLowerCase(),
            destination: input.destinationAccountId,
            source_transaction: input.chargeId,
          },
          { idempotencyKey: input.idempotencyKey },
        );
        return { transferId: transfer.id };
      } catch (err) {
        throw stripeFailure(err);
      }
    },
    async reverseTransfer(input) {
      try {
        await stripe().transfers.createReversal(
          input.transferId,
          { amount: input.amountCents },
          { idempotencyKey: input.idempotencyKey },
        );
      } catch (err) {
        throw badGateway("payment_provider_error", err);
      }
    },
    async retrieveInvoiceChargeId(invoiceId) {
      try {
        // `invoice.charge` e `invoice.payment_intent` não existem mais nesta versão da API:
        // a cobrança vive em `payments.data[].payment.charge`. O limite de 4 níveis de
        // expand impede puxar o `balance_transaction` na mesma chamada — daí o
        // `retrieveChargeFee` separado.
        const invoice = await stripe().invoices.retrieve(invoiceId, {
          expand: ["payments.data.payment.charge"],
        });
        const charge = (
          invoice as unknown as {
            payments?: { data?: Array<{ payment?: { charge?: string | { id: string } } }> };
          }
        ).payments?.data?.[0]?.payment?.charge;
        if (!charge) return null;
        return typeof charge === "string" ? charge : charge.id;
      } catch (err) {
        throw badGateway("payment_provider_error", err);
      }
    },
    async refundPaymentIntent(input) {
      // Ordem importa: reverter antes de reembolsar. Reembolsar primeiro e falhar no
      // reversal deixaria a plataforma no negativo sem registro do porquê.
      let reversalFailed = false;
      if (input.transferId) {
        try {
          // Reverte o LÍQUIDO, não o bruto: o Stripe não devolve a taxa de processamento no
          // reembolso, e quem fica com esse custo é a loja — a taxa é dela, e a venda
          // existiu de verdade até ser desfeita (ADR-029).
          await stripe().transfers.createReversal(
            input.transferId,
            { amount: input.netCents },
            { idempotencyKey: `reversal:${input.idempotencyKey}` },
          );
        } catch {
          // Loja já sacou o dinheiro: o Stripe não puxa de conta vazia. O comprador não pode
          // ficar preso ao caixa da loja, então o reembolso segue e a pendência volta para
          // quem chamou — que tem logger e contexto do pagamento para registrá-la.
          reversalFailed = true;
        }
      }
      try {
        // Deterministic idempotency key: a network failure after Stripe has already accepted
        // the refund must not turn a retry into a second refund attempt (or, combined with
        // releaseRefundClaim on throw, a "charge_already_refunded" 502 on every subsequent
        // retry once the claim is released back to "succeeded").
        await stripe().refunds.create(
          { payment_intent: input.providerId },
          { idempotencyKey: input.idempotencyKey },
        );
      } catch (err) {
        throw badGateway("payment_provider_error", err);
      }
      return { reversalFailed };
    },
    async createDonationSubscription(input) {
      // Separate charges and transfers (ADR-029): customer, product e subscription nascem
      // na PLATAFORMA e a cobrança de cada ciclo fica inteira aqui. O repasse sai por fatura
      // paga, com a taxa real daquele ciclo — `transfer_data` na subscription repassaria o
      // bruto todo mês. Sem `on_behalf_of`: a plataforma é o merchant of record (plataforma
      // e núcleos todos no BR, então não cai na exceção cross-border que obrigaria o
      // parâmetro) — ver ADR-025.
      try {
        const customer = await stripe().customers.create({ email: input.customerEmail });
        // `price_data` de subscription exige um Product já existente: ao contrário do
        // Checkout Session, não aceita `product_data` inline. Um Product por loja, reusado,
        // em vez de um por doação — senão a conta enche de Products órfãos.
        const productId =
          input.productId ?? (await stripe().products.create({ name: input.productName })).id;
        const subscription = await stripe().subscriptions.create({
          customer: customer.id,
          items: [
            {
              price_data: {
                currency: input.currency.toLowerCase(),
                product: productId,
                recurring: { interval: "month" },
                unit_amount: input.amountCents,
              },
            },
          ],
          payment_behavior: "default_incomplete",
          payment_settings: { save_default_payment_method: "on_subscription" },
          expand: ["latest_invoice.confirmation_secret"],
          metadata: input.metadata,
        });
        const invoice = subscription.latest_invoice;
        const clientSecret =
          invoice && typeof invoice !== "string"
            ? (invoice.confirmation_secret?.client_secret ?? null)
            : null;
        if (!clientSecret) throw new Error("stripe_missing_confirmation_secret");
        return { subscriptionId: subscription.id, clientSecret, productId };
      } catch (err) {
        throw badGateway("payment_provider_error", err);
      }
    },
    async cancelSubscription(subscriptionId) {
      try {
        // Sem `stripeAccount`: a assinatura de doação vive na conta da plataforma.
        await stripe().subscriptions.cancel(subscriptionId);
      } catch (err) {
        throw badGateway("payment_provider_error", err);
      }
    },
    async createConnectedAccount(input) {
      try {
        // Controller properties equivalentes a Express, sem o parâmetro `type` (legado).
        // Em destination charge quem cobra é a plataforma: o negativo de refund e de
        // disputa cai no saldo dela, então ela é obrigatoriamente a dona das perdas — e
        // `losses.payments: application` exige `fees.payer: application`. A capability
        // `transfers` é o que permite o dinheiro chegar no núcleo — ver ADR-024.
        const account = await stripe().accounts.create({
          country: cfg.connectCountry ?? "BR",
          email: input.email,
          business_profile: { name: input.storeName },
          controller: {
            losses: { payments: "application" },
            fees: { payer: "application" },
            // a Stripe continua coletando e mantendo o KYC em dia, sem fluxo de
            // remediação próprio do nosso lado
            requirement_collection: "stripe",
            stripe_dashboard: { type: "express" },
          },
          // No BR a Stripe recusa `transfers` sozinho: "You cannot request the
          // `transfers` capability without the `card_payments` capability for accounts
          // in BR". Sem as duas, a criação da conta conectada falha com 400 e o núcleo
          // nunca sai do "configurar recebimento".
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        });
        return { accountId: account.id };
      } catch (err) {
        throw badGateway("payment_provider_error", err);
      }
    },
    async createAccountSession(accountId) {
      try {
        // Sessão curta que autoriza os componentes embutidos no /gestao. O
        // notification_banner vai sempre: é ele que avisa o núcleo quando o Stripe passa a
        // exigir dado novo, antes da conta ser desabilitada — ver ADR-026.
        const session = await stripe().accountSessions.create({
          account: accountId,
          components: {
            account_onboarding: { enabled: true },
            notification_banner: { enabled: true },
          },
        });
        return { clientSecret: session.client_secret };
      } catch (err) {
        throw badGateway("payment_provider_error", err);
      }
    },
    async createExpressDashboardLink(accountId) {
      try {
        // Conta Express não entra em dashboard.stripe.com: o acesso é por login link de
        // uso único que a plataforma gera. Por isso a rota o cria a cada chamada.
        const link = await stripe().accounts.createLoginLink(accountId);
        return { url: link.url };
      } catch (err) {
        throw badGateway("payment_provider_error", err);
      }
    },
    async createAccountLink(input) {
      try {
        // O link expira em minutos e é de uso único: por isso a rota o gera a cada
        // chamada em vez de guardar a URL.
        const link = await stripe().accountLinks.create({
          account: input.accountId,
          refresh_url: input.refreshUrl,
          return_url: input.returnUrl,
          type: "account_onboarding",
        });
        return { url: link.url };
      } catch (err) {
        throw badGateway("payment_provider_error", err);
      }
    },
    async retrieveAccountStatus(accountId) {
      try {
        const account = await stripe().accounts.retrieve(accountId);
        return {
          transfersEnabled: account.capabilities?.transfers === "active",
          chargesEnabled: account.charges_enabled === true,
          payoutsEnabled: account.payouts_enabled === true,
          detailsSubmitted: account.details_submitted === true,
        };
      } catch (err) {
        throw badGateway("payment_provider_error", err);
      }
    },
    async createSaasCheckoutSession(input) {
      try {
        // Sem `stripeAccount`: a assinatura SaaS é receita da plataforma, cobrada na
        // conta da plataforma. Nada aqui passa por Connect.
        const session = await stripe().checkout.sessions.create({
          mode: "subscription",
          line_items: [{ price: input.priceId, quantity: 1 }],
          ...(input.customerId
            ? { customer: input.customerId }
            : { customer_email: input.customerEmail }),
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          client_reference_id: input.storeId,
          // A partir de Basil o Checkout só cria a Subscription depois do pagamento, então
          // os eventos de subscription chegam sem passar pela sessão: a metadata precisa
          // viajar nos dois objetos para o webhook saber de que loja se trata.
          metadata: { storeId: input.storeId },
          subscription_data: { metadata: { storeId: input.storeId } },
        });
        if (!session.url) throw new Error("stripe_missing_checkout_url");
        return { url: session.url, sessionId: session.id };
      } catch (err) {
        throw badGateway("payment_provider_error", err);
      }
    },
    async createBillingPortalSession(input) {
      try {
        const session = await stripe().billingPortal.sessions.create({
          customer: input.customerId,
          return_url: input.returnUrl,
        });
        return { url: session.url };
      } catch (err) {
        throw badGateway("payment_provider_error", err);
      }
    },
    verifyWebhook(rawBody, signature) {
      // Dois endpoints, dois segredos: o da plataforma (assinatura SaaS) e o de Connect
      // (account.updated, doação mensal na conta do núcleo). A requisição não diz qual é,
      // então tenta os dois e só falha se nenhum assinar. O de Connect é opcional para não
      // quebrar ambiente de teste que só configura a plataforma.
      const secrets = [cfg.webhookSecret, cfg.connectWebhookSecret].filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      );
      let lastError: unknown = new Error("stripe_webhook_no_secret_configured");
      for (const secret of secrets) {
        try {
          const event = stripe().webhooks.constructEvent(rawBody, signature, secret);
          return event as unknown as StripeWebhookEvent;
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError;
    },
  };
}
