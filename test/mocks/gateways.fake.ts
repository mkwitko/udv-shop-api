import type { GoogleProfile } from "../../src/gateways/google/google.gateway.js";
import type {
  ConnectedAccountStatus,
  CreateDonationSubscriptionInput,
  CreatePaymentIntentInput,
  CreateSaasCheckoutInput,
} from "../../src/gateways/stripe/stripe.gateway.js";
import type {
  CreateChargeInput,
  CreateSubAccountInput,
} from "../../src/gateways/woovi/woovi.gateway.js";
import type { Gateways } from "../../src/types/fastify.js";

export type FakeGateways = Gateways & {
  sentEmails: Array<{ to: string; subject: string; html: string }>;
  googleProfile: GoogleProfile;
  stripeIntents: CreatePaymentIntentInput[];
  stripeRefunds: string[];
  stripeSubscriptions: CreateDonationSubscriptionInput[];
  stripeCancelledSubscriptions: string[];
  stripeConnectedAccounts: Array<{ email: string; storeName: string }>;
  stripeAccountLinks: Array<{ accountId: string; refreshUrl: string; returnUrl: string }>;
  stripeAccountStatus: ConnectedAccountStatus;
  stripeSaasCheckouts: CreateSaasCheckoutInput[];
  stripePortalSessions: Array<{ customerId: string; returnUrl: string }>;
  wooviSubAccounts: CreateSubAccountInput[];
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
  const stripeSubscriptions: FakeGateways["stripeSubscriptions"] = [];
  const stripeCancelledSubscriptions: string[] = [];
  const stripeConnectedAccounts: FakeGateways["stripeConnectedAccounts"] = [];
  const stripeAccountLinks: FakeGateways["stripeAccountLinks"] = [];
  const stripeAccountStatus: ConnectedAccountStatus = {
    chargesEnabled: false,
    payoutsEnabled: false,
    detailsSubmitted: false,
  };
  const stripeSaasCheckouts: FakeGateways["stripeSaasCheckouts"] = [];
  const stripePortalSessions: FakeGateways["stripePortalSessions"] = [];
  const wooviSubAccounts: FakeGateways["wooviSubAccounts"] = [];
  const wooviCharges: FakeGateways["wooviCharges"] = [];
  const wooviRefunds: FakeGateways["wooviRefunds"] = [];
  return {
    sentEmails,
    googleProfile,
    stripeIntents,
    stripeRefunds,
    stripeSubscriptions,
    stripeCancelledSubscriptions,
    stripeConnectedAccounts,
    stripeAccountLinks,
    stripeAccountStatus,
    stripeSaasCheckouts,
    stripePortalSessions,
    wooviSubAccounts,
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
      async createDonationSubscription(input) {
        stripeSubscriptions.push(input);
        return {
          subscriptionId: `sub_fake_${stripeSubscriptions.length}`,
          clientSecret: "cs_sub_fake",
        };
      },
      async cancelSubscription(subscriptionId, _connectedAccountId) {
        stripeCancelledSubscriptions.push(subscriptionId);
      },
      async createConnectedAccount(input) {
        stripeConnectedAccounts.push(input);
        return { accountId: `acct_fake_${stripeConnectedAccounts.length}` };
      },
      async createAccountLink(input) {
        stripeAccountLinks.push(input);
        // A URL real do onboarding hospedado não carrega o id da conta — mantê-la sem ele
        // aqui é o que dá poder ao teste de vazamento na resposta da rota.
        return { url: `https://connect.fake/onboard/${stripeAccountLinks.length}` };
      },
      async retrieveAccountStatus(_accountId) {
        return stripeAccountStatus;
      },
      async createSaasCheckoutSession(input) {
        stripeSaasCheckouts.push(input);
        return {
          url: `https://checkout.fake/${stripeSaasCheckouts.length}`,
          sessionId: `cs_fake_${stripeSaasCheckouts.length}`,
        };
      },
      async createBillingPortalSession(input) {
        stripePortalSessions.push(input);
        return { url: `https://portal.fake/${input.customerId}` };
      },
      verifyWebhook(rawBody, signature) {
        if (signature === "invalid") throw new Error("invalid_signature");
        return JSON.parse(rawBody.toString("utf8"));
      },
    },
    woovi: overrides.woovi ?? {
      async createSubAccount(input) {
        wooviSubAccounts.push(input);
        return { subAccountId: `woovi_sub_${wooviSubAccounts.length}` };
      },
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
