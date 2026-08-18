import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { logger } from "../../src/infra/observability/logger.js";
import { relayOutbox } from "../../src/workers/outbox-relay.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways, type FakeGateways } from "../mocks/gateways.fake.js";

async function seed() {
  const store = await db.store.create({
    data: {
      slug: "nucleo-r",
      name: "Núcleo R",
      status: "active",
      stripeAccountId: "acct_1",
      applicationFeeBps: 500,
    },
  });
  const campaign = await db.campaign.create({
    data: { storeId: store.id, slug: "reforma", title: "Reforma", status: "active" },
  });
  const raffle = await db.raffle.create({
    data: { campaignId: campaign.id, centsPerNumber: 1000 },
  });
  return { store, campaign, raffle };
}

async function customerToken(app: FastifyInstance, email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Doador", email, password: "senha-forte-123" },
  });
  return res.json().accessToken as string;
}

function donate(app: FastifyInstance, token: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/donations",
    headers: { authorization: `Bearer ${token}` },
    payload: { storeSlug: "nucleo-r", provider: "stripe", ...payload },
  });
}

function stripeEvent(app: FastifyInstance, event: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: { "stripe-signature": "ok", "content-type": "application/json" },
    payload: JSON.stringify(event),
  });
}

describe("reembolso e órfão de doação", () => {
  let app: FastifyInstance;
  let gateways: FakeGateways;
  beforeAll(async () => {
    gateways = buildFakeGateways();
    app = await buildApp({ gateways });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("charge.refunded de doação única: doação refunded e as entradas do sorteio aberto são devolvidas", async () => {
    await seed();
    const token = await customerToken(app, "r1@example.org");
    const res = await donate(app, token, { amountCents: 5000, campaignSlug: "reforma" });
    const donationId = res.json().donation.id as string;
    const payment = await db.payment.findFirstOrThrow({ where: { donationId } });

    await stripeEvent(app, {
      id: "evt_ok",
      type: "payment_intent.succeeded",
      data: { object: { id: payment.providerId, metadata: { paymentId: payment.id } } },
    });
    await relayOutbox({ db, email: gateways.email, log: logger });
    expect(await db.raffleEntry.count({ where: { donationId } })).toBe(5);

    const refundRes = await stripeEvent(app, {
      id: "evt_refund",
      type: "charge.refunded",
      data: { object: { id: "ch_1", payment_intent: payment.providerId } },
    });
    expect(refundRes.statusCode).toBe(200);

    const donation = await db.donation.findUniqueOrThrow({ where: { id: donationId } });
    expect(donation.status).toBe("refunded");
    expect(donation.raffleGranted).toBe(false);
    expect(await db.raffleEntry.count({ where: { donationId } })).toBe(0);
  });

  it("charge.refunded de doação mensal chega só com o invoice: encontra o pagamento pelo providerId do ciclo", async () => {
    await seed();
    const token = await customerToken(app, "r2@example.org");
    const res = await donate(app, token, { type: "monthly", amountCents: 3000 });
    const donationId = res.json().donation.id as string;
    const subscriptionId = res.json().payment.subscriptionId as string;

    await stripeEvent(app, {
      id: "evt_inv",
      type: "invoice.paid",
      // Assinatura de doação é direct charge na conta do núcleo: o evento nasce lá.
      account: "acct_1",
      data: {
        object: {
          id: "in_1",
          parent: { subscription_details: { subscription: subscriptionId } },
          amount_paid: 3000,
        },
      },
    });
    expect((await db.donation.findUniqueOrThrow({ where: { id: donationId } })).status).toBe(
      "paid",
    );

    // O charge de um ciclo de assinatura não traz payment_intent nosso: providerId do
    // pagamento é o id do invoice.
    const refundRes = await stripeEvent(app, {
      id: "evt_refund_sub",
      type: "charge.refunded",
      data: { object: { id: "ch_2", invoice: "in_1" } },
    });
    expect(refundRes.statusCode).toBe(200);

    const donation = await db.donation.findUniqueOrThrow({ where: { id: donationId } });
    expect(donation.status).toBe("refunded");
    const payment = await db.payment.findFirstOrThrow({ where: { donationId } });
    expect(payment.status).toBe("refunded");
  });

  it("pagamento confirmado para doação já cancelada gera outbox payment.orphaned com donationId", async () => {
    await seed();
    const token = await customerToken(app, "r3@example.org");
    const res = await donate(app, token, { amountCents: 5000, campaignSlug: "reforma" });
    const donationId = res.json().donation.id as string;
    const payment = await db.payment.findFirstOrThrow({ where: { donationId } });

    await stripeEvent(app, {
      id: "evt_cancel",
      type: "payment_intent.canceled",
      data: { object: { id: payment.providerId, metadata: { paymentId: payment.id } } },
    });
    expect((await db.donation.findUniqueOrThrow({ where: { id: donationId } })).status).toBe(
      "cancelled",
    );

    await stripeEvent(app, {
      id: "evt_late_ok",
      type: "payment_intent.succeeded",
      data: { object: { id: payment.providerId, metadata: { paymentId: payment.id } } },
    });

    const orphaned = await db.outboxEvent.findMany({ where: { type: "payment.orphaned" } });
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]?.payload).toMatchObject({ donationId, paymentId: payment.id });
    expect(await db.outboxEvent.count({ where: { type: "donation.received" } })).toBe(0);
  });
});
