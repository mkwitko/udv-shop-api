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
  chargesRetrieve: vi.fn(),
  transfersCreate: vi.fn(),
  transfersCreateReversal: vi.fn(),
  invoicesRetrieve: vi.fn(),
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
    charges = { retrieve: stripeMock.chargesRetrieve };
    transfers = {
      create: stripeMock.transfersCreate,
      createReversal: stripeMock.transfersCreateReversal,
    };
    invoices = { retrieve: stripeMock.invoicesRetrieve };
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
  stripeMock.chargesRetrieve.mockReset();
  stripeMock.transfersCreate.mockReset();
  stripeMock.transfersCreateReversal.mockReset();
  stripeMock.invoicesRetrieve.mockReset();
});

describe("createPaymentIntent (separate charges and transfers)", () => {
  const input = {
    amountCents: 5000,
    currency: "BRL",
    metadata: { orderId: "o1", paymentId: "p1" },
  };

  it("não manda transfer_data: o repasse sai depois, com a taxa real descontada", async () => {
    stripeMock.paymentIntentsCreate.mockResolvedValue({ id: "pi_1", client_secret: "cs_1" });
    await gw().createPaymentIntent(input);

    const payload = stripeMock.paymentIntentsCreate.mock.calls[0]?.[0];
    expect(payload).toMatchObject({ amount: 5000, currency: "brl" });
    // transfer_data e application_fee_amount são fixados aqui, quando a taxa real que o
    // balance_transaction só revela depois ainda não existe — por isso saíram (ADR-029).
    expect(payload).not.toHaveProperty("transfer_data");
    expect(payload).not.toHaveProperty("application_fee_amount");
    // on_behalf_of faria do núcleo o settlement merchant — a plataforma é o MoR
    expect(payload).not.toHaveProperty("on_behalf_of");
  });

  it("conta conectada inválida vira erro acionável, não 502 genérico", async () => {
    // o Stripe recusa quando o id da conta não existe mais (ou nunca existiu, como o
    // do seed antigo): 502 "payment_provider_error" mandava a loja procurar um problema
    // de plataforma que era, na verdade, o Connect dela
    stripeMock.paymentIntentsCreate.mockRejectedValue(
      Object.assign(new Error("does not have access to account"), { code: "account_invalid" }),
    );

    await expect(gw().createPaymentIntent(input)).rejects.toMatchObject({
      message: "store_stripe_account_invalid",
      statusCode: 409,
    });
  });

  it("outros erros do Stripe continuam 502", async () => {
    stripeMock.paymentIntentsCreate.mockRejectedValue(
      Object.assign(new Error("api down"), { code: "api_error" }),
    );

    await expect(gw().createPaymentIntent(input)).rejects.toMatchObject({
      message: "payment_provider_error",
      statusCode: 502,
    });
  });
});

describe("retrieveChargeFee", () => {
  it("lê a taxa do balance_transaction expandido", async () => {
    stripeMock.chargesRetrieve.mockResolvedValue({
      amount: 5000,
      currency: "brl",
      balance_transaction: { fee: 239 },
    });

    await expect(gw().retrieveChargeFee("ch_1")).resolves.toEqual({
      amountCents: 5000,
      feeCents: 239,
      currency: "brl",
    });
    expect(stripeMock.chargesRetrieve).toHaveBeenCalledWith("ch_1", {
      expand: ["balance_transaction"],
    });
  });

  it("falha alto quando o balance_transaction não veio expandido", async () => {
    // Um id em string aqui significaria repassar o bruto e a plataforma comer a taxa —
    // silenciosamente. Melhor 502 e o outbox tentar de novo.
    stripeMock.chargesRetrieve.mockResolvedValue({
      amount: 5000,
      currency: "brl",
      balance_transaction: "txn_1",
    });

    await expect(gw().retrieveChargeFee("ch_1")).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe("createTransfer", () => {
  it("repassa amarrado à cobrança, para não adiantar do saldo da plataforma", async () => {
    stripeMock.transfersCreate.mockResolvedValue({ id: "tr_1" });

    await expect(
      gw().createTransfer({
        amountCents: 4761,
        currency: "brl",
        destinationAccountId: "acct_nucleo",
        chargeId: "ch_1",
        idempotencyKey: "transfer:p1",
      }),
    ).resolves.toEqual({ transferId: "tr_1" });

    expect(stripeMock.transfersCreate).toHaveBeenCalledWith(
      {
        amount: 4761,
        currency: "brl",
        destination: "acct_nucleo",
        source_transaction: "ch_1",
      },
      { idempotencyKey: "transfer:p1" },
    );
  });

  it("conta conectada inválida no repasse também vira erro acionável", async () => {
    stripeMock.transfersCreate.mockRejectedValue(
      Object.assign(new Error("no such destination"), { code: "account_invalid" }),
    );

    await expect(
      gw().createTransfer({
        amountCents: 4761,
        currency: "brl",
        destinationAccountId: "acct_sumiu",
        chargeId: "ch_1",
        idempotencyKey: "transfer:p1",
      }),
    ).rejects.toMatchObject({ message: "store_stripe_account_invalid", statusCode: 409 });
  });
});

describe("retrieveInvoiceChargeId", () => {
  it("acha o charge pelo array payments: invoice.charge não existe mais nesta API", async () => {
    stripeMock.invoicesRetrieve.mockResolvedValue({
      payments: { data: [{ payment: { charge: { id: "ch_inv" } } }] },
    });

    await expect(gw().retrieveInvoiceChargeId("in_1")).resolves.toBe("ch_inv");
    expect(stripeMock.invoicesRetrieve).toHaveBeenCalledWith("in_1", {
      expand: ["payments.data.payment.charge"],
    });
  });

  it("aceita o charge como id solto, não só expandido", async () => {
    stripeMock.invoicesRetrieve.mockResolvedValue({
      payments: { data: [{ payment: { charge: "ch_str" } }] },
    });
    await expect(gw().retrieveInvoiceChargeId("in_1")).resolves.toBe("ch_str");
  });

  it("devolve null quando a fatura não gerou cobrança (valor zero, crédito)", async () => {
    stripeMock.invoicesRetrieve.mockResolvedValue({ payments: { data: [] } });
    await expect(gw().retrieveInvoiceChargeId("in_1")).resolves.toBeNull();
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
  it("reverte o líquido repassado e só depois reembolsa o comprador", async () => {
    stripeMock.transfersCreateReversal.mockResolvedValue({ id: "trr_1" });
    stripeMock.refundsCreate.mockResolvedValue({ id: "re_1" });

    await expect(
      gw().refundPaymentIntent({
        providerId: "pi_1",
        transferId: "tr_1",
        netCents: 4761,
        idempotencyKey: "refund-pay-1",
      }),
    ).resolves.toEqual({ reversalFailed: false });

    // Reverte o LÍQUIDO: o Stripe não devolve a taxa de processamento, e quem fica com esse
    // custo é a loja — a taxa é dela (ADR-029).
    expect(stripeMock.transfersCreateReversal).toHaveBeenCalledWith(
      "tr_1",
      { amount: 4761 },
      { idempotencyKey: "reversal:refund-pay-1" },
    );
    const payload = stripeMock.refundsCreate.mock.calls[0]?.[0];
    expect(payload).toMatchObject({ payment_intent: "pi_1" });
    // Sem destination charge estes dois não existem mais; mandá-los é erro de API.
    expect(payload).not.toHaveProperty("reverse_transfer");
    expect(payload).not.toHaveProperty("refund_application_fee");
  });

  it("reembolsa sem reverter quando o repasse ainda não saiu", async () => {
    stripeMock.refundsCreate.mockResolvedValue({ id: "re_2" });

    await gw().refundPaymentIntent({
      providerId: "pi_2",
      transferId: null,
      netCents: 4761,
      idempotencyKey: "refund-pay-2",
    });

    expect(stripeMock.transfersCreateReversal).not.toHaveBeenCalled();
    expect(stripeMock.refundsCreate).toHaveBeenCalled();
  });

  it("reembolsa o comprador mesmo se o reversal falhar por saldo da loja", async () => {
    // A loja já sacou. Prender o reembolso do comprador ao caixa da loja seria punir quem
    // não tem nada a ver com isso; a pendência volta para quem chamou registrar.
    stripeMock.transfersCreateReversal.mockRejectedValue(
      Object.assign(new Error("insufficient"), { code: "balance_insufficient" }),
    );
    stripeMock.refundsCreate.mockResolvedValue({ id: "re_3" });

    await expect(
      gw().refundPaymentIntent({
        providerId: "pi_3",
        transferId: "tr_3",
        netCents: 4761,
        idempotencyKey: "refund-pay-3",
      }),
    ).resolves.toEqual({ reversalFailed: true });
    expect(stripeMock.refundsCreate).toHaveBeenCalled();
  });

  it("erro do provider no reembolso vira 502 payment_provider_error", async () => {
    stripeMock.refundsCreate.mockRejectedValue(new Error("network"));
    await expect(
      gw().refundPaymentIntent({
        providerId: "pi_1",
        transferId: null,
        netCents: 4761,
        idempotencyKey: "refund-pay-1",
      }),
    ).rejects.toMatchObject({ statusCode: 502, message: "payment_provider_error" });
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
