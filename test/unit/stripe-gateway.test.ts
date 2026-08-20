import { beforeEach, describe, expect, it, vi } from "vitest";

const stripeMock = vi.hoisted(() => ({
  refundsCreate: vi.fn(),
  paymentIntentsCreate: vi.fn(),
  accountsCreate: vi.fn(),
  accountsRetrieve: vi.fn(),
  accountsCreateLoginLink: vi.fn(),
  customersCreate: vi.fn(),
  productsCreate: vi.fn(),
  subscriptionsCreate: vi.fn(),
  subscriptionsCancel: vi.fn(),
  accountSessionsCreate: vi.fn(),
  constructEvent: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class FakeStripe {
    paymentIntents = { create: stripeMock.paymentIntentsCreate };
    refunds = { create: stripeMock.refundsCreate };
    accounts = {
      create: stripeMock.accountsCreate,
      retrieve: stripeMock.accountsRetrieve,
      createLoginLink: stripeMock.accountsCreateLoginLink,
    };
    customers = { create: stripeMock.customersCreate };
    products = { create: stripeMock.productsCreate };
    subscriptions = {
      create: stripeMock.subscriptionsCreate,
      cancel: stripeMock.subscriptionsCancel,
    };
    accountSessions = { create: stripeMock.accountSessionsCreate };
    webhooks = { constructEvent: stripeMock.constructEvent };
  },
}));

const { createStripeGateway } = await import("../../src/gateways/stripe/stripe.gateway.js");

const gw = () =>
  createStripeGateway({
    secretKey: "sk_test",
    webhookSecret: "whsec_plataforma",
    connectWebhookSecret: "whsec_connect",
  });

beforeEach(() => {
  stripeMock.refundsCreate.mockReset();
  stripeMock.paymentIntentsCreate.mockReset();
  stripeMock.accountsCreate.mockReset();
  stripeMock.accountsRetrieve.mockReset();
  stripeMock.accountsCreateLoginLink.mockReset();
  stripeMock.customersCreate.mockReset();
  stripeMock.productsCreate.mockReset();
  stripeMock.subscriptionsCreate.mockReset();
  stripeMock.subscriptionsCancel.mockReset();
  stripeMock.accountSessionsCreate.mockReset();
  stripeMock.constructEvent.mockReset();
});

describe("createPaymentIntent", () => {
  const input = {
    amountCents: 5000,
    currency: "BRL",
    destinationAccountId: "acct_nucleo",
    metadata: { orderId: "o1", paymentId: "p1" },
  };

  it("omite application_fee_amount quando não há comissão, em vez de mandar zero", async () => {
    stripeMock.paymentIntentsCreate.mockResolvedValue({ id: "pi_1", client_secret: "cs_1" });
    await gw().createPaymentIntent({ ...input, applicationFeeCents: 0 });

    const payload = stripeMock.paymentIntentsCreate.mock.calls[0]?.[0];
    expect(payload).toMatchObject({ transfer_data: { destination: "acct_nucleo" } });
    // fee zero mandado explicitamente criaria ApplicationFee de R$ 0 em todo pagamento
    expect(payload).not.toHaveProperty("application_fee_amount");
  });

  it("manda a comissão quando ela existe (o campo continua por loja)", async () => {
    stripeMock.paymentIntentsCreate.mockResolvedValue({ id: "pi_1", client_secret: "cs_1" });
    await gw().createPaymentIntent({ ...input, applicationFeeCents: 250 });

    expect(stripeMock.paymentIntentsCreate.mock.calls[0]?.[0]).toMatchObject({
      application_fee_amount: 250,
    });
  });
});

describe("createDonationSubscription", () => {
  const input = {
    amountCents: 3000,
    currency: "BRL",
    applicationFeePercent: 5,
    destinationAccountId: "acct_nucleo",
    customerEmail: "doador@example.org",
    productName: "Doação mensal — Núcleo A",
    productId: null,
    metadata: { donationId: "d1", paymentId: "p1" },
  };

  beforeEach(() => {
    stripeMock.customersCreate.mockResolvedValue({ id: "cus_1" });
    stripeMock.productsCreate.mockResolvedValue({ id: "prod_1" });
    stripeMock.subscriptionsCreate.mockResolvedValue({
      id: "sub_1",
      latest_invoice: { confirmation_secret: { client_secret: "cs_1" } },
    });
  });

  it("omite application_fee_percent quando não há comissão", async () => {
    await gw().createDonationSubscription({ ...input, applicationFeePercent: 0 });
    expect(stripeMock.subscriptionsCreate.mock.calls[0]?.[0]).not.toHaveProperty(
      "application_fee_percent",
    );
  });

  it("cria na plataforma com transfer_data, sem header de conta conectada e sem on_behalf_of", async () => {
    await expect(gw().createDonationSubscription(input)).resolves.toEqual({
      subscriptionId: "sub_1",
      clientSecret: "cs_1",
      productId: "prod_1",
    });

    const [payload, opts] = stripeMock.subscriptionsCreate.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      customer: "cus_1",
      transfer_data: { destination: "acct_nucleo" },
      application_fee_percent: 5,
      payment_behavior: "default_incomplete",
    });
    // on_behalf_of faria do núcleo o settlement merchant — a plataforma é o MoR
    expect(payload).not.toHaveProperty("on_behalf_of");
    // nenhuma chamada autenticada COMO a conta conectada
    expect(opts).toBeUndefined();
    expect(stripeMock.customersCreate).toHaveBeenCalledWith({ email: input.customerEmail });
  });

  it("reusa o Product da loja quando já existe", async () => {
    await expect(
      gw().createDonationSubscription({ ...input, productId: "prod_existente" }),
    ).resolves.toMatchObject({ productId: "prod_existente" });

    expect(stripeMock.productsCreate).not.toHaveBeenCalled();
    expect(stripeMock.subscriptionsCreate.mock.calls[0]?.[0]?.items?.[0]?.price_data?.product).toBe(
      "prod_existente",
    );
  });

  it("cancela na plataforma, sem conta conectada", async () => {
    stripeMock.subscriptionsCancel.mockResolvedValue({ id: "sub_1" });
    await gw().cancelSubscription("sub_1");
    expect(stripeMock.subscriptionsCancel).toHaveBeenCalledWith("sub_1");
  });
});

describe("createConnectedAccount", () => {
  it("usa controller properties de Express e pede a capability transfers, sem o parâmetro type legado", async () => {
    stripeMock.accountsCreate.mockResolvedValue({ id: "acct_novo" });

    await expect(
      gw().createConnectedAccount({ email: "nucleo@example.org", storeName: "Núcleo X" }),
    ).resolves.toEqual({ accountId: "acct_novo" });

    const payload = stripeMock.accountsCreate.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      country: "BR",
      email: "nucleo@example.org",
      controller: {
        // destination charge: o negativo cai no saldo da plataforma, então é ela a dona
        losses: { payments: "application" },
        fees: { payer: "application" },
        requirement_collection: "stripe",
        stripe_dashboard: { type: "express" },
      },
      capabilities: { transfers: { requested: true } },
    });
    expect(payload).not.toHaveProperty("type");
  });
});

describe("createExpressDashboardLink", () => {
  it("gera login link de uso único para a conta", async () => {
    stripeMock.accountsCreateLoginLink.mockResolvedValue({ url: "https://connect.stripe.com/x" });

    await expect(gw().createExpressDashboardLink("acct_1")).resolves.toEqual({
      url: "https://connect.stripe.com/x",
    });
    expect(stripeMock.accountsCreateLoginLink).toHaveBeenCalledWith("acct_1");
  });
});

describe("createAccountSession", () => {
  it("habilita onboarding e o notification banner, que é o que avisa de requisito novo", async () => {
    stripeMock.accountSessionsCreate.mockResolvedValue({ client_secret: "acct_sess_1" });

    await expect(gw().createAccountSession("acct_1")).resolves.toEqual({
      clientSecret: "acct_sess_1",
    });
    expect(stripeMock.accountSessionsCreate).toHaveBeenCalledWith({
      account: "acct_1",
      components: {
        account_onboarding: { enabled: true },
        notification_banner: { enabled: true },
      },
    });
  });
});

describe("refundPaymentIntent", () => {
  it("reverte o transfer e a application fee: em destination charge o dinheiro já saiu para o núcleo", async () => {
    stripeMock.refundsCreate.mockResolvedValue({ id: "re_1" });
    await gw().refundPaymentIntent("pi_1", "refund-pay-1");

    expect(stripeMock.refundsCreate).toHaveBeenCalledWith(
      {
        payment_intent: "pi_1",
        reverse_transfer: true,
        refund_application_fee: true,
      },
      { idempotencyKey: "refund-pay-1" },
    );
  });

  it("erro do provider vira 502 payment_provider_error", async () => {
    stripeMock.refundsCreate.mockRejectedValue(new Error("network"));
    await expect(gw().refundPaymentIntent("pi_1", "refund-pay-1")).rejects.toMatchObject({
      statusCode: 502,
      message: "payment_provider_error",
    });
  });
});

describe("retrieveAccountStatus", () => {
  it("lê a capability transfers, que é o que libera a destination charge", async () => {
    stripeMock.accountsRetrieve.mockResolvedValue({
      capabilities: { transfers: "active", card_payments: "inactive" },
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
    });

    await expect(gw().retrieveAccountStatus("acct_1")).resolves.toEqual({
      transfersEnabled: true,
      chargesEnabled: true,
      payoutsEnabled: false,
      detailsSubmitted: true,
    });
  });

  it("transfers pendente não conta como habilitada", async () => {
    stripeMock.accountsRetrieve.mockResolvedValue({ capabilities: { transfers: "pending" } });
    const status = await gw().retrieveAccountStatus("acct_1");
    expect(status.transfersEnabled).toBe(false);
  });
});

describe("verifyWebhook", () => {
  it("aceita evento assinado com o secret da plataforma", () => {
    stripeMock.constructEvent.mockImplementation((_body, _sig, secret: string) => {
      if (secret !== "whsec_plataforma") throw new Error("no signatures found");
      return { id: "evt_1", type: "customer.subscription.updated", data: { object: {} } };
    });

    expect(gw().verifyWebhook(Buffer.from("{}"), "sig")).toMatchObject({ id: "evt_1" });
  });

  it("aceita evento de conta conectada, que vem de outro endpoint e outro secret", () => {
    stripeMock.constructEvent.mockImplementation((_body, _sig, secret: string) => {
      if (secret !== "whsec_connect") throw new Error("no signatures found");
      return { id: "evt_2", type: "account.updated", account: "acct_1", data: { object: {} } };
    });

    expect(gw().verifyWebhook(Buffer.from("{}"), "sig")).toMatchObject({
      id: "evt_2",
      account: "acct_1",
    });
  });

  it("assinatura que não bate com nenhum dos dois secrets propaga o erro", () => {
    stripeMock.constructEvent.mockImplementation(() => {
      throw new Error("no signatures found matching the expected signature");
    });

    expect(() => gw().verifyWebhook(Buffer.from("{}"), "sig")).toThrow(/no signatures found/);
    expect(stripeMock.constructEvent).toHaveBeenCalledTimes(2);
  });

  it("sem nenhum secret configurado falha em vez de aceitar qualquer coisa", () => {
    const semSecret = createStripeGateway({ secretKey: "sk_test", webhookSecret: "" });
    expect(() => semSecret.verifyWebhook(Buffer.from("{}"), "sig")).toThrow(
      /stripe_webhook_no_secret_configured/,
    );
    expect(stripeMock.constructEvent).not.toHaveBeenCalled();
  });
});
