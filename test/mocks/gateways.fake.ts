import type {
  WriteDescriptionInput,
  WritePrizeInput,
  WriteStoreInput,
  WriteStoryInput,
} from "../../src/gateways/ai/ai.gateway.js";
import type { GoogleProfile } from "../../src/gateways/google/google.gateway.js";
import type {
  ConnectedAccountStatus,
  CreateDonationSubscriptionInput,
  CreatePaymentIntentInput,
  CreateSaasCheckoutInput,
  CreateTransferInput,
} from "../../src/gateways/stripe/stripe.gateway.js";
import type {
  CreateChargeInput,
  CreatePlainChargeInput,
  CreateSubAccountInput,
  PixKeyOwner,
} from "../../src/gateways/woovi/woovi.gateway.js";
import type { Gateways } from "../../src/types/fastify.js";

/**
 * Taxa e valor que a cobrança Stripe falsa devolve quando o teste não diz outra coisa.
 * R$ 50,00 com R$ 2,39 de taxa é a ordem de grandeza real do cartão no BR — número redondo
 * demais esconderia erro de arredondamento no líquido.
 */
const FAKE_CHARGE_AMOUNT_CENTS = 5000;
const FAKE_STRIPE_FEE_CENTS = 239;

export type FakeGateways = Gateways & {
  sentEmails: Array<{ to: string | string[]; subject: string; html: string }>;
  googleProfile: GoogleProfile;
  stripeIntents: CreatePaymentIntentInput[];
  stripeRefunds: string[];
  /** Repasses pedidos ao Stripe, na ordem — o líquido de cada cobrança. */
  stripeTransfers: CreateTransferInput[];
  /** Reversals pedidos, por transfer. */
  stripeReversals: Array<{ transferId: string; amountCents: number }>;
  /**
   * Taxa que a cobrança falsa devolve, por charge. Sem entrada, a taxa é
   * FAKE_STRIPE_FEE_CENTS sobre um valor igual ao do último intent criado.
   */
  stripeChargeFees: Map<string, { amountCents: number; feeCents: number; currency: string }>;
  /** Charge que cada fatura falsa aponta. Sem entrada, a fatura não gerou cobrança. */
  stripeInvoiceCharges: Map<string, string>;
  stripeSubscriptions: CreateDonationSubscriptionInput[];
  stripeCancelledSubscriptions: string[];
  stripeConnectedAccounts: Array<{ email: string; storeName: string }>;
  stripeAccountLinks: Array<{ accountId: string; refreshUrl: string; returnUrl: string }>;
  stripeDashboardLinks: string[];
  stripeAccountSessions: string[];
  stripeAccountStatus: ConnectedAccountStatus;
  stripeSaasCheckouts: CreateSaasCheckoutInput[];
  stripePortalSessions: Array<{ customerId: string; returnUrl: string }>;
  wooviSubAccounts: CreateSubAccountInput[];
  wooviCharges: CreateChargeInput[];
  /** Cobranças sem split (o centavo da prova de posse da chave Pix). */
  wooviPlainCharges: CreatePlainChargeInput[];
  /**
   * Dono que a consulta de chave Pix falsa devolve, por chave. Sem entrada, a chave existe
   * com um dono genérico — é o caso comum, e obrigar cada teste a cadastrar dono só faria
   * ruído. Quem testa chave inexistente usa `wooviPixKeyUnknown`.
   */
  wooviPixKeyOwners: Map<string, PixKeyOwner>;
  /** Chaves que o Banco Central não conhece na Woovi falsa. */
  wooviPixKeyUnknown: Set<string>;
  wooviRefunds: Array<{ chargeCorrelationID: string; refundCorrelationID: string }>;
  /** Saques Woovi pedidos, na ordem. */
  wooviWithdrawals: string[];
  /** Saldo que a subconta falsa devolve, por chave Pix. O teste escreve aqui. */
  wooviBalances: Map<string, number>;
  /** Chaves cujo saque a Woovi falsa recusa. */
  wooviWithdrawBlocked: Set<string>;
  /** CNAMEs que o DNS falso devolve, por host. O teste escreve aqui. */
  dnsCnames: Map<string, string[]>;
  /** Pedidos de descrição que chegaram na IA falsa. */
  aiDescriptionCalls: WriteDescriptionInput[];
  /** Pedidos de história de campanha que chegaram na IA falsa. */
  aiStoryCalls: WriteStoryInput[];
  /** Pedidos de descrição de prêmio que chegaram na IA falsa. */
  aiPrizeCalls: WritePrizeInput[];
  /** Pedidos de descrição de loja que chegaram na IA falsa. */
  aiStoreCalls: WriteStoreInput[];
};

export function buildFakeGateways(overrides: Partial<Gateways> = {}): FakeGateways {
  const sentEmails: FakeGateways["sentEmails"] = [];
  const dnsCnames: FakeGateways["dnsCnames"] = new Map();
  const googleProfile: GoogleProfile = {
    sub: "google-sub-1",
    email: "google@example.org",
    emailVerified: true,
    name: "Pessoa Google",
  };
  const stripeIntents: FakeGateways["stripeIntents"] = [];
  const stripeRefunds: string[] = [];
  const stripeTransfers: FakeGateways["stripeTransfers"] = [];
  const stripeReversals: FakeGateways["stripeReversals"] = [];
  const stripeChargeFees: FakeGateways["stripeChargeFees"] = new Map();
  const stripeInvoiceCharges: FakeGateways["stripeInvoiceCharges"] = new Map();
  const stripeSubscriptions: FakeGateways["stripeSubscriptions"] = [];
  const stripeCancelledSubscriptions: string[] = [];
  const stripeConnectedAccounts: FakeGateways["stripeConnectedAccounts"] = [];
  const stripeAccountLinks: FakeGateways["stripeAccountLinks"] = [];
  const stripeDashboardLinks: string[] = [];
  const stripeAccountSessions: string[] = [];
  const stripeAccountStatus: ConnectedAccountStatus = {
    transfersEnabled: false,
    chargesEnabled: false,
    payoutsEnabled: false,
    detailsSubmitted: false,
  };
  const stripeSaasCheckouts: FakeGateways["stripeSaasCheckouts"] = [];
  const stripePortalSessions: FakeGateways["stripePortalSessions"] = [];
  const wooviSubAccounts: FakeGateways["wooviSubAccounts"] = [];
  const wooviCharges: FakeGateways["wooviCharges"] = [];
  const wooviPlainCharges: FakeGateways["wooviPlainCharges"] = [];
  const wooviPixKeyOwners: FakeGateways["wooviPixKeyOwners"] = new Map();
  const wooviPixKeyUnknown: FakeGateways["wooviPixKeyUnknown"] = new Set();
  const wooviRefunds: FakeGateways["wooviRefunds"] = [];
  const wooviWithdrawals: string[] = [];
  const wooviBalances: FakeGateways["wooviBalances"] = new Map();
  const wooviWithdrawBlocked: FakeGateways["wooviWithdrawBlocked"] = new Set();
  const aiDescriptionCalls: FakeGateways["aiDescriptionCalls"] = [];
  const aiStoryCalls: FakeGateways["aiStoryCalls"] = [];
  const aiPrizeCalls: FakeGateways["aiPrizeCalls"] = [];
  const aiStoreCalls: FakeGateways["aiStoreCalls"] = [];
  return {
    sentEmails,
    aiDescriptionCalls,
    aiStoryCalls,
    aiPrizeCalls,
    aiStoreCalls,
    dnsCnames,
    googleProfile,
    stripeIntents,
    stripeRefunds,
    stripeTransfers,
    stripeReversals,
    stripeChargeFees,
    stripeInvoiceCharges,
    stripeSubscriptions,
    stripeCancelledSubscriptions,
    stripeConnectedAccounts,
    stripeAccountLinks,
    stripeDashboardLinks,
    stripeAccountSessions,
    stripeAccountStatus,
    stripeSaasCheckouts,
    stripePortalSessions,
    wooviSubAccounts,
    wooviCharges,
    wooviPlainCharges,
    wooviPixKeyOwners,
    wooviPixKeyUnknown,
    wooviRefunds,
    wooviWithdrawals,
    wooviBalances,
    wooviWithdrawBlocked,
    ai: overrides.ai ?? {
      configured: true,
      async writeProductDescription(input) {
        aiDescriptionCalls.push(input);
        return `Texto da IA para ${input.productName} (${input.mode}).`;
      },
      async writeCampaignStory(input) {
        aiStoryCalls.push(input);
        return `História da IA para ${input.campaignTitle} (${input.mode}).`;
      },
      async writePrizeDescription(input) {
        aiPrizeCalls.push(input);
        return `Prêmio da IA para ${input.prizeTitle} (${input.mode}).`;
      },
      async writeStoreDescription(input) {
        aiStoreCalls.push(input);
        return `Loja da IA para ${input.storeName} (${input.mode}).`;
      },
    },
    dns: overrides.dns ?? {
      resolveCname: async (host) => dnsCnames.get(host) ?? [],
    },
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
      async retrieveChargeFee(chargeId) {
        return (
          stripeChargeFees.get(chargeId) ?? {
            amountCents: FAKE_CHARGE_AMOUNT_CENTS,
            feeCents: FAKE_STRIPE_FEE_CENTS,
            currency: "brl",
          }
        );
      },
      async createTransfer(input) {
        stripeTransfers.push(input);
        return { transferId: `tr_fake_${stripeTransfers.length}` };
      },
      async reverseTransfer(input) {
        stripeReversals.push({ transferId: input.transferId, amountCents: input.amountCents });
      },
      async retrieveInvoiceChargeId(invoiceId) {
        return stripeInvoiceCharges.get(invoiceId) ?? null;
      },
      async createDonationSubscription(input) {
        stripeSubscriptions.push(input);
        return {
          subscriptionId: `sub_fake_${stripeSubscriptions.length}`,
          clientSecret: "cs_sub_fake",
          // Product da loja é reusado quando já existe, como no gateway real.
          productId: input.productId ?? `prod_fake_${stripeSubscriptions.length}`,
        };
      },
      async cancelSubscription(subscriptionId) {
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
      async createAccountSession(accountId) {
        stripeAccountSessions.push(accountId);
        return { clientSecret: `acct_sess_fake_${stripeAccountSessions.length}` };
      },
      async createExpressDashboardLink(accountId) {
        stripeDashboardLinks.push(accountId);
        // Login link real também não expõe o id da conta na URL.
        return { url: `https://connect.fake/dashboard/${stripeDashboardLinks.length}` };
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
      async getSubAccount(pixKey) {
        if (!wooviBalances.has(pixKey)) return null;
        return {
          name: "Subconta",
          pixKey,
          balanceCents: wooviBalances.get(pixKey) ?? 0,
          withdrawBlocked: wooviWithdrawBlocked.has(pixKey),
        };
      },
      async withdrawSubAccount(pixKey) {
        wooviWithdrawals.push(pixKey);
        if (wooviWithdrawBlocked.has(pixKey)) {
          return { status: "blocked" as const, message: "saque bloqueado" };
        }
        const saldo = wooviBalances.get(pixKey) ?? 0;
        if (saldo <= 0) return { status: "empty" as const };
        // saque leva TODO o saldo: é a semântica da Woovi
        wooviBalances.set(pixKey, 0);
        return { status: "requested" as const };
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
      async checkPixKey(pixKey) {
        if (wooviPixKeyUnknown.has(pixKey)) return null;
        return (
          wooviPixKeyOwners.get(pixKey) ?? {
            pixKey,
            type: "EMAIL" as const,
            name: "Dona da Chave",
            // mesma máscara que a Woovi devolve para CPF: 3 primeiros + 2 últimos
            taxId: "000.***.***-91",
          }
        );
      },
      async createPlainCharge(input) {
        wooviPlainCharges.push(input);
        return {
          providerId: `woovi_fake_plain_${wooviPlainCharges.length}`,
          brCode: "000201fakeplain",
          qrCodeImageUrl: "https://fake.woovi/qr-verificacao.png",
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
    // Desligado por padrão, como numa plataforma sem segredo configurado. Quem quer testar o
    // caminho com desafio passa um override: `{ turnstile: fakeTurnstile("ok") }`.
    turnstile: overrides.turnstile ?? { enabled: false, verify: async () => true },
  };
}
