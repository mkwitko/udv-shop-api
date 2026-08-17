import Stripe from "stripe";
import { badGateway } from "../../shared/errors.js";

export type StripeWebhookEvent = {
  id: string;
  type: string;
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

export interface StripeGateway {
  createPaymentIntent(
    input: CreatePaymentIntentInput,
  ): Promise<{ providerId: string; clientSecret: string }>;
  refundPaymentIntent(providerId: string, idempotencyKey: string): Promise<void>;
  // Implementação completa (customer/produto/preço/assinatura na conta conectada) chega
  // na Task 4 — aqui só a assinatura do método, para o service da Task 3 tipar contra ela.
  createDonationSubscription(
    input: CreateDonationSubscriptionInput,
  ): Promise<{ subscriptionId: string; clientSecret: string }>;
  cancelSubscription(subscriptionId: string, connectedAccountId: string): Promise<void>;
  verifyWebhook(rawBody: Buffer, signature: string): StripeWebhookEvent;
}

export function createStripeGateway(cfg: {
  secretKey: string;
  webhookSecret: string;
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
      // Direct charge na conta conectada (Stripe-Account header): Billing + application fee
      // não funciona em destination charge (ver D3/ADR-016 citado no service da Task 3).
      // Substituído por completo na Task 4 com o teste real do fluxo mensal.
      const opts = { stripeAccount: input.destinationAccountId };
      try {
        const customer = await stripe().customers.create({ email: input.customerEmail }, opts);
        const product = await stripe().products.create({ name: input.productName }, opts);
        const price = await stripe().prices.create(
          {
            unit_amount: input.amountCents,
            currency: input.currency.toLowerCase(),
            recurring: { interval: "month" },
            product: product.id,
          },
          opts,
        );
        const subscription = await stripe().subscriptions.create(
          {
            customer: customer.id,
            items: [{ price: price.id }],
            payment_behavior: "default_incomplete",
            payment_settings: { save_default_payment_method: "on_subscription" },
            expand: ["latest_invoice.confirmation_secret"],
            application_fee_percent: input.applicationFeePercent,
            metadata: input.metadata,
          },
          opts,
        );
        const invoice = subscription.latest_invoice;
        const clientSecret =
          invoice && typeof invoice === "object"
            ? (invoice.confirmation_secret?.client_secret ?? null)
            : null;
        if (!clientSecret) throw new Error("stripe_missing_client_secret");
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
    verifyWebhook(rawBody, signature) {
      const event = stripe().webhooks.constructEvent(rawBody, signature, cfg.webhookSecret);
      return event as unknown as StripeWebhookEvent;
    },
  };
}
