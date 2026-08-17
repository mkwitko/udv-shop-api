import type { GoogleProfile } from "../../src/gateways/google/google.gateway.js";
import type { CreatePaymentIntentInput } from "../../src/gateways/stripe/stripe.gateway.js";
import type { CreateChargeInput } from "../../src/gateways/woovi/woovi.gateway.js";
import type { Gateways } from "../../src/types/fastify.js";

export type FakeGateways = Gateways & {
  sentEmails: Array<{ to: string; subject: string; html: string }>;
  googleProfile: GoogleProfile;
  stripeIntents: CreatePaymentIntentInput[];
  stripeRefunds: string[];
  wooviCharges: CreateChargeInput[];
  wooviRefunds: Array<{ chargeCorrelationID: string; refundCorrelationID: string }>;
};

export function buildFakeGateways(overrides: Partial<Gateways> = {}): FakeGateways {
  const sentEmails: FakeGateways["sentEmails"] = [];
  const googleProfile: GoogleProfile = {
    sub: "google-sub-1",
    email: "google@example.org",
    emailVerified: true,
    name: "Pessoa Google",
  };
  const stripeIntents: FakeGateways["stripeIntents"] = [];
  const stripeRefunds: string[] = [];
  const wooviCharges: FakeGateways["wooviCharges"] = [];
  const wooviRefunds: FakeGateways["wooviRefunds"] = [];
  return {
    sentEmails,
    googleProfile,
    stripeIntents,
    stripeRefunds,
    wooviCharges,
    wooviRefunds,
    email: overrides.email ?? {
      async send(input) {
        sentEmails.push(input);
      },
    },
    google:
      overrides.google ??
      ({
        authUrl: (state: string, nonce: string) =>
          `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&nonce=${nonce}`,
        exchangeCode: async () => googleProfile,
      } satisfies Gateways["google"]),
    r2: overrides.r2 ?? {
      presignPut: async ({ key }) => `https://fake-r2.local/put/${key}`,
      publicUrl: (key) => `https://cdn.fake/${key}`,
    },
    stripe: overrides.stripe ?? {
      async createPaymentIntent(input) {
        stripeIntents.push(input);
        return { providerId: `pi_fake_${stripeIntents.length}`, clientSecret: "cs_fake" };
      },
      async refundPaymentIntent(providerId, _idempotencyKey) {
        stripeRefunds.push(providerId);
      },
      verifyWebhook(rawBody, signature) {
        if (signature === "invalid") throw new Error("invalid_signature");
        return JSON.parse(rawBody.toString("utf8"));
      },
    },
    woovi: overrides.woovi ?? {
      async createCharge(input) {
        wooviCharges.push(input);
        return {
          providerId: `woovi_fake_${wooviCharges.length}`,
          brCode: "000201fake",
          qrCodeImageUrl: "https://fake.woovi/qr.png",
          expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
        };
      },
      async refundCharge(input) {
        wooviRefunds.push(input);
      },
      verifyWebhook(_rawBody, signature) {
        return signature !== "invalid";
      },
    },
  };
}
