import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways, type FakeGateways } from "../mocks/gateways.fake.js";

async function customerToken(app: FastifyInstance, email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Doador", email, password: "senha-forte-123" },
  });
  return res.json().accessToken as string;
}

async function seedStore(overrides: Record<string, unknown> = {}) {
  return db.store.create({
    data: {
      slug: "nucleo-a",
      name: "Núcleo A",
      status: "active",
      stripeAccountId: "acct_1",
      wooviPixKey: "pix@nucleo.org",
      applicationFeeBps: 500,
      ...overrides,
    },
  });
}

async function seedCampaign(
  storeId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ slug: string; id: string }> {
  return db.campaign.create({
    data: {
      storeId,
      slug: "reforma-do-salao",
      title: "Reforma do salão",
      status: "active",
      ...overrides,
    },
  });
}

function donate(app: FastifyInstance, token: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/donations",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      storeSlug: "nucleo-a",
      provider: "stripe",
      amountCents: 10_000,
      ...payload,
    },
  });
}

function stripeEvent(app: FastifyInstance, event: Record<string, unknown>, signature = "ok") {
  return app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: { "stripe-signature": signature, "content-type": "application/json" },
    payload: JSON.stringify(event),
  });
}

describe("POST /donations", () => {
  let app: FastifyInstance;
  let gateways: FakeGateways;
  beforeAll(async () => {
    gateways = buildFakeGateways();
    app = await buildApp({ gateways });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("avulsa sem campanha via woovi: 201, brCode presente, applicationFeeCents calculado, sem campos sensíveis na resposta", async () => {
    const store = await seedStore();
    const token = await customerToken(app, "d1@example.org");
    const res = await donate(app, token, { provider: "woovi" });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.payment.provider).toBe("woovi");
    expect(json.payment.brCode).toBe("000201fake");
    expect(json.donation.campaign).toBeNull();

    const payment = await db.payment.findFirstOrThrow();
    expect(payment.donationId).not.toBeNull();
    expect(payment.applicationFeeCents).toBe(500); // floor(10000 * 500 / 10000)

    expect(JSON.stringify(json)).not.toContain(store.wooviPixKey as string);
    expect(JSON.stringify(json)).not.toContain("applicationFeeBps");
    expect(JSON.stringify(json)).not.toContain("applicationFeeCents");
    expect(JSON.stringify(json)).not.toContain("stripeAccountId");
  });

  it("para campanha active via stripe: 201, metadata do intent contém donationId e paymentId", async () => {
    const store = await seedStore();
    const campaign = await seedCampaign(store.id);
    const token = await customerToken(app, "d2@example.org");
    const res = await donate(app, token, { provider: "stripe", campaignSlug: campaign.slug });
    expect(res.statusCode).toBe(201);
    const donationId = res.json().donation.id as string;
    const payment = await db.payment.findFirstOrThrow();
    const intent = gateways.stripeIntents.at(-1);
    expect(intent?.metadata).toMatchObject({ donationId, paymentId: payment.id });
  });

  it.each([
    ["draft", { status: "draft" }],
    ["paused", { status: "paused" }],
    ["active com endsAt vencido", { status: "active", endsAt: new Date(Date.now() - 60_000) }],
  ])("campanha %s → 400 campaign_not_open", async (_label, overrides) => {
    const store = await seedStore();
    const campaign = await seedCampaign(store.id, overrides);
    const token = await customerToken(app, `d3-${_label}@example.org`.replace(/\s/g, ""));
    const res = await donate(app, token, { campaignSlug: campaign.slug });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("campaign_not_open");
  });

  it("campanha acceptedTypes one_time com type monthly → 400 donation_type_not_accepted", async () => {
    const store = await seedStore();
    const campaign = await seedCampaign(store.id, { acceptedTypes: "one_time" });
    const token = await customerToken(app, "d4@example.org");
    const res = await donate(app, token, {
      provider: "stripe",
      campaignSlug: campaign.slug,
      type: "monthly",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("donation_type_not_accepted");
  });

  it("provider woovi + type monthly → 400 monthly_not_supported_for_provider", async () => {
    await seedStore();
    const token = await customerToken(app, "d5@example.org");
    const res = await donate(app, token, { provider: "woovi", type: "monthly" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("monthly_not_supported_for_provider");
  });

  it("loja sem wooviPixKey → 400 payments_not_configured", async () => {
    await seedStore({ wooviPixKey: null });
    const token = await customerToken(app, "d6@example.org");
    const res = await donate(app, token, { provider: "woovi" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("payments_not_configured");
  });

  it("valor abaixo de DONATION_MIN_CENTS → 400 de validação", async () => {
    await seedStore();
    const token = await customerToken(app, "d7@example.org");
    const res = await donate(app, token, { amountCents: 100 });
    expect(res.statusCode).toBe(400);
  });

  it("gateway lançando erro → 502 e doação cancelled com pagamento failed", async () => {
    const failing = buildFakeGateways();
    failing.woovi.createCharge = async () => {
      throw new Error("boom");
    };
    const app2 = await buildApp({ gateways: failing });
    await app2.ready();
    await seedStore();
    const token = await customerToken(app2, "d8@example.org");
    const res = await donate(app2, token, { provider: "woovi" });
    expect(res.statusCode).toBe(502);
    const donation = await db.donation.findFirstOrThrow();
    expect(donation.status).toBe("cancelled");
    const payment = await db.payment.findFirstOrThrow();
    expect(payment.status).toBe("failed");
    await app2.close();
  });

  it("webhook OPENPIX:CHARGE_COMPLETED com correlationID = paymentId → doação paid, pagamento succeeded, um outbox donation.received", async () => {
    await seedStore();
    const token = await customerToken(app, "d9@example.org");
    const res = await donate(app, token, { provider: "woovi" });
    const donationId = res.json().donation.id as string;
    const payment = await db.payment.findFirstOrThrow({ where: { donationId } });

    const webhookRes = await app.inject({
      method: "POST",
      url: "/webhooks/woovi",
      headers: { "x-openpix-signature": "ok", "content-type": "application/json" },
      payload: JSON.stringify({
        event: "OPENPIX:CHARGE_COMPLETED",
        charge: { correlationID: payment.id, identifier: payment.providerId },
      }),
    });
    expect(webhookRes.statusCode).toBe(200);

    const freshDonation = await db.donation.findUniqueOrThrow({ where: { id: donationId } });
    expect(freshDonation.status).toBe("paid");
    const freshPayment = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(freshPayment.status).toBe("succeeded");
    expect(await db.outboxEvent.count({ where: { type: "donation.received" } })).toBe(1);
  });

  it("D1: pagamento de doação processado pelo webhook nunca deixa payment succeeded com donation pending_payment", async () => {
    await seedStore();
    const token = await customerToken(app, "d10@example.org");
    const res = await donate(app, token, { provider: "stripe" });
    const donationId = res.json().donation.id as string;
    const payment = await db.payment.findFirstOrThrow({ where: { donationId } });

    await stripeEvent(app, {
      id: "evt_d1",
      type: "payment_intent.succeeded",
      data: {
        object: { id: payment.providerId, metadata: { donationId, paymentId: payment.id } },
      },
    });

    const freshPayment = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    const freshDonation = await db.donation.findUniqueOrThrow({ where: { id: donationId } });
    expect(freshPayment.status === "succeeded" && freshDonation.status === "pending_payment").toBe(
      false,
    );
    expect(freshPayment.status).toBe("succeeded");
    expect(freshDonation.status).toBe("paid");
  });

  it("sem token → 401", async () => {
    await seedStore();
    const res = await app.inject({ method: "POST", url: "/donations", payload: {} });
    expect(res.statusCode).toBe(401);
  });
});
