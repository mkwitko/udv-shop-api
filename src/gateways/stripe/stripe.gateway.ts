import Stripe from "stripe";
import { badGateway } from "../../shared/errors.js";

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
  applicationFeeCents: number;
  destinationAccountId: string;
  metadata: Record<string, string>;
};

export type CreateDonationSubscriptionInput = {
  amountCents: number;
  currency: string;
  applicationFeePercent: number;
  destinationAccountId: string;
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
  refundPaymentIntent(providerId: string, idempotencyKey: string): Promise<void>;
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
      const intent = await stripe().paymentIntents.create({
        amount: input.amountCents,
        currency: input.currency.toLowerCase(),
        automatic_payment_methods: { enabled: true },
        // Sem comissão por venda (ADR-027) o campo é omitido em vez de mandado zerado:
        // `application_fee_amount: 0` cria ApplicationFee de R$ 0 em todo pagamento e
        // sujaria o relatório da plataforma sem significar nada.
        ...(input.applicationFeeCents > 0
          ? { application_fee_amount: input.applicationFeeCents }
          : {}),
        transfer_data: { destination: input.destinationAccountId },
        metadata: input.metadata,
      });
      if (!intent.client_secret) throw new Error("stripe_missing_client_secret");
      return { providerId: intent.id, clientSecret: intent.client_secret };
    },
    async refundPaymentIntent(providerId, idempotencyKey) {
      try {
        // Deterministic idempotency key: a network failure after Stripe has already accepted
        // the refund must not turn a retry into a second refund attempt (or, combined with
        // releaseRefundClaim on throw, a "charge_already_refunded" 502 on every subsequent
        // retry once the claim is released back to "succeeded").
        await stripe().refunds.create(
          {
            payment_intent: providerId,
            // Destination charge: the money already left for the connected account when the
            // charge succeeded. Refunding without reversing takes the whole amount out of the
            // PLATFORM's balance while the store keeps its share — the platform eats the loss.
            // reverse_transfer pulls the store's share back, refund_application_fee gives the
            // buyer's fee portion back too instead of leaving it as platform revenue on a sale
            // that no longer exists.
            reverse_transfer: true,
            refund_application_fee: true,
          },
          { idempotencyKey },
        );
      } catch (err) {
        throw badGateway("payment_provider_error", err);
      }
    },
    async createDonationSubscription(input) {
      // Destination charge, igual à doação única: customer, product e subscription nascem
      // na PLATAFORMA, e `transfer_data` manda o líquido para o núcleo. Sem `on_behalf_of`
      // — a plataforma é o merchant of record (plataforma e núcleos todos no BR, então não
      // cai na exceção cross-border que obrigaria o parâmetro) — ver ADR-025.
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
          transfer_data: { destination: input.destinationAccountId },
          // Mesmo motivo do PaymentIntent: fee zero é fee ausente (ADR-027).
          ...(input.applicationFeePercent > 0
            ? { application_fee_percent: input.applicationFeePercent }
            : {}),
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
