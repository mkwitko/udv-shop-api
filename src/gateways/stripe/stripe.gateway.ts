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
  metadata: Record<string, string>;
};

export type ConnectedAccountStatus = {
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
  ): Promise<{ subscriptionId: string; clientSecret: string }>;
  cancelSubscription(subscriptionId: string, connectedAccountId: string): Promise<void>;
  createConnectedAccount(input: {
    email: string;
    storeName: string;
  }): Promise<{ accountId: string }>;
  createAccountLink(input: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
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
        application_fee_amount: input.applicationFeeCents,
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
        await stripe().refunds.create({ payment_intent: providerId }, { idempotencyKey });
      } catch (err) {
        throw badGateway("payment_provider_error", err);
      }
    },
    async createDonationSubscription(input) {
      // Billing com Connect exige direct charge: autenticamos COMO a conta conectada
      // (Stripe-Account) e o customer/price nascem lá. Difere da cobrança única, que usa
      // destination charge na conta da plataforma — ver ADR-016.
      const opts = { stripeAccount: input.destinationAccountId };
      try {
        const customer = await stripe().customers.create({ email: input.customerEmail }, opts);
        // `price_data` de subscription exige um Product já existente: ao contrário do
        // Checkout Session, não aceita `product_data` inline. O Product nasce na conta
        // conectada (mesmo `opts`), senão o id não resolve no direct charge.
        const product = await stripe().products.create({ name: input.productName }, opts);
        const subscription = await stripe().subscriptions.create(
          {
            customer: customer.id,
            items: [
              {
                price_data: {
                  currency: input.currency.toLowerCase(),
                  product: product.id,
                  recurring: { interval: "month" },
                  unit_amount: input.amountCents,
                },
              },
            ],
            application_fee_percent: input.applicationFeePercent,
            payment_behavior: "default_incomplete",
            payment_settings: { save_default_payment_method: "on_subscription" },
            expand: ["latest_invoice.confirmation_secret"],
            metadata: input.metadata,
          },
          opts,
        );
        const invoice = subscription.latest_invoice;
        const clientSecret =
          invoice && typeof invoice !== "string"
            ? (invoice.confirmation_secret?.client_secret ?? null)
            : null;
        if (!clientSecret) throw new Error("stripe_missing_confirmation_secret");
        return { subscriptionId: subscription.id, clientSecret };
      } catch (err) {
        throw badGateway("payment_provider_error", err);
      }
    },
    async cancelSubscription(subscriptionId, connectedAccountId) {
      try {
        await stripe().subscriptions.cancel(
          subscriptionId,
          {},
          { stripeAccount: connectedAccountId },
        );
      } catch (err) {
        throw badGateway("payment_provider_error", err);
      }
    },
    async createConnectedAccount(input) {
      try {
        // Standard: o núcleo tem dashboard próprio e é dono da relação com o Stripe
        // (obrigações fiscais, disputas). A plataforma só cobra application_fee — ver ADR-020.
        const account = await stripe().accounts.create({
          type: "standard",
          country: cfg.connectCountry ?? "BR",
          email: input.email,
          business_profile: { name: input.storeName },
        });
        return { accountId: account.id };
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
      const event = stripe().webhooks.constructEvent(rawBody, signature, cfg.webhookSecret);
      return event as unknown as StripeWebhookEvent;
    },
  };
}
