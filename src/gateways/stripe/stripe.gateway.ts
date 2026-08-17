import Stripe from "stripe";

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

export interface StripeGateway {
  createPaymentIntent(
    input: CreatePaymentIntentInput,
  ): Promise<{ providerId: string; clientSecret: string }>;
  refundPaymentIntent(providerId: string): Promise<void>;
  verifyWebhook(rawBody: Buffer, signature: string): StripeWebhookEvent;
}

export function createStripeGateway(cfg: {
  secretKey: string;
  webhookSecret: string;
}): StripeGateway {
  let client: Stripe | null = null;
  const stripe = () => {
    client ??= new Stripe(cfg.secretKey);
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
    async refundPaymentIntent(providerId) {
      await stripe().refunds.create({ payment_intent: providerId });
    },
    verifyWebhook(rawBody, signature) {
      const event = stripe().webhooks.constructEvent(rawBody, signature, cfg.webhookSecret);
      return event as unknown as StripeWebhookEvent;
    },
  };
}
