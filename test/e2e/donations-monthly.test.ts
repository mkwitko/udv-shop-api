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

function donateMonthly(app: FastifyInstance, token: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/donations",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      storeSlug: "nucleo-a",
      provider: "stripe",
      type: "monthly",
      amountCents: 3000,
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

function cancelSubscription(app: FastifyInstance, token: string, donationId: string) {
  return app.inject({
    method: "DELETE",
    url: `/donations/${donationId}/subscription`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("doação mensal — assinatura Stripe", () => {
  let app: FastifyInstance;
  let gateways: FakeGateways;
  beforeAll(async () => {
    gateways = buildFakeGateways();
    app = await buildApp({ gateways });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("POST /donations mensal: 201, payment.provider stripe_subscription, subscriptionId presente, doação pending_payment com subscriptionRef, applicationFeePercent = applicationFeeBps/100", async () => {
    const store = await seedStore({ applicationFeeBps: 750 });
    const token = await customerToken(app, "m1@example.org");
    const res = await donateMonthly(app, token);
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.payment.provider).toBe("stripe_subscription");
    expect(typeof json.payment.subscriptionId).toBe("string");

    const donation = await db.donation.findUniqueOrThrow({ where: { id: json.donation.id } });
    expect(donation.status).toBe("pending_payment");
    expect(donation.subscriptionRef).toBe(json.payment.subscriptionId);

    const subscription = gateways.stripeSubscriptions.at(-1);
    expect(subscription?.applicationFeePercent).toBe(store.applicationFeeBps / 100);
  });

  it("invoice.paid subscription_create: doação âncora vira paid, ganha providerInvoiceId, pagamento succeeded, um outbox donation.received", async () => {
    await seedStore();
    const token = await customerToken(app, "m2@example.org");
    const res = await donateMonthly(app, token);
    const donationId = res.json().donation.id as string;
    const subscriptionId = res.json().payment.subscriptionId as string;

    const webhookRes = await stripeEvent(app, {
      id: "evt_inv_1",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_1",
          // Forma Basil+ (API fixada: 2026-07-29.dahlia). O campo plano `subscription`
          // não existe mais no Invoice.
          parent: { subscription_details: { subscription: subscriptionId } },
          amount_paid: 3000,
          billing_reason: "subscription_create",
        },
      },
    });
    expect(webhookRes.statusCode).toBe(200);

    const donation = await db.donation.findUniqueOrThrow({ where: { id: donationId } });
    expect(donation.status).toBe("paid");
    expect(donation.providerInvoiceId).toBe("in_1");
    const payment = await db.payment.findFirstOrThrow({ where: { donationId } });
    expect(payment.status).toBe("succeeded");
    expect(await db.outboxEvent.count({ where: { type: "donation.received" } })).toBe(1);
  });

  it("reprocessar o mesmo invoice.paid (outro event_id, mesmo invoice.id): nenhuma doação nova, nenhum outbox novo", async () => {
    await seedStore();
    const token = await customerToken(app, "m3@example.org");
    const res = await donateMonthly(app, token);
    const subscriptionId = res.json().payment.subscriptionId as string;

    const payload = {
      type: "invoice.paid",
      data: {
        object: {
          id: "in_1",
          // Forma Basil+ (API fixada: 2026-07-29.dahlia). O campo plano `subscription`
          // não existe mais no Invoice.
          parent: { subscription_details: { subscription: subscriptionId } },
          amount_paid: 3000,
          billing_reason: "subscription_create",
        },
      },
    };
    await stripeEvent(app, { id: "evt_inv_1", ...payload });
    const donationCountBefore = await db.donation.count();
    const outboxCountBefore = await db.outboxEvent.count({ where: { type: "donation.received" } });

    const replayRes = await stripeEvent(app, { id: "evt_inv_1_replay", ...payload });
    expect(replayRes.statusCode).toBe(200);

    expect(await db.donation.count()).toBe(donationCountBefore);
    expect(await db.outboxEvent.count({ where: { type: "donation.received" } })).toBe(
      outboxCountBefore,
    );
  });

  it("invoice.paid subscription_cycle: nova linha Donation paid com mesmo subscriptionRef, campaignId e amountCents, Payment succeeded próprio e outbox donation.received", async () => {
    const store = await seedStore();
    const campaign = await db.campaign.create({
      data: {
        storeId: store.id,
        slug: "reforma-do-salao",
        title: "Reforma do salão",
        status: "active",
      },
    });
    const token = await customerToken(app, "m4@example.org");
    const res = await donateMonthly(app, token, { campaignSlug: campaign.slug });
    const anchorId = res.json().donation.id as string;
    const subscriptionId = res.json().payment.subscriptionId as string;

    await stripeEvent(app, {
      id: "evt_inv_anchor",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_1",
          // Forma Basil+ (API fixada: 2026-07-29.dahlia). O campo plano `subscription`
          // não existe mais no Invoice.
          parent: { subscription_details: { subscription: subscriptionId } },
          amount_paid: 3000,
          billing_reason: "subscription_create",
        },
      },
    });

    const cycleRes = await stripeEvent(app, {
      id: "evt_inv_cycle",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_2",
          // Forma Basil+ (API fixada: 2026-07-29.dahlia). O campo plano `subscription`
          // não existe mais no Invoice.
          parent: { subscription_details: { subscription: subscriptionId } },
          amount_paid: 3000,
          billing_reason: "subscription_cycle",
        },
      },
    });
    expect(cycleRes.statusCode).toBe(200);

    const donations = await db.donation.findMany({
      where: { subscriptionRef: subscriptionId },
      orderBy: { createdAt: "asc" },
    });
    expect(donations).toHaveLength(2);
    const child = donations[1] as (typeof donations)[number];
    expect(child.id).not.toBe(anchorId);
    expect(child.status).toBe("paid");
    expect(child.campaignId).toBe(campaign.id);
    expect(child.amountCents).toBe(3000);
    expect(child.providerInvoiceId).toBe("in_2");

    const childPayment = await db.payment.findFirstOrThrow({ where: { donationId: child.id } });
    expect(childPayment.status).toBe("succeeded");
    expect(await db.outboxEvent.count({ where: { type: "donation.received" } })).toBe(2);
  });

  it("DELETE /donations/:id/subscription do próprio doador: 202 subscription_cancelled, gateway chamado com subscriptionRef, subscriptionCancelledAt preenchido, subscriptionActive false", async () => {
    await seedStore();
    const token = await customerToken(app, "m5@example.org");
    const res = await donateMonthly(app, token);
    const donationId = res.json().donation.id as string;
    const subscriptionId = res.json().payment.subscriptionId as string;

    const cancelRes = await cancelSubscription(app, token, donationId);
    expect(cancelRes.statusCode).toBe(202);
    expect(cancelRes.json().status).toBe("subscription_cancelled");
    expect(gateways.stripeCancelledSubscriptions).toContain(subscriptionId);

    const donation = await db.donation.findUniqueOrThrow({ where: { id: donationId } });
    expect(donation.subscriptionCancelledAt).not.toBeNull();
    expect(
      donation.type === "monthly" &&
        donation.subscriptionRef !== null &&
        donation.subscriptionCancelledAt === null,
    ).toBe(false);
  });

  it("cancelar doação de outra pessoa: 404", async () => {
    await seedStore();
    const owner = await customerToken(app, "m6-owner@example.org");
    const other = await customerToken(app, "m6-other@example.org");
    const res = await donateMonthly(app, owner);
    const donationId = res.json().donation.id as string;

    const cancelRes = await cancelSubscription(app, other, donationId);
    expect(cancelRes.statusCode).toBe(404);
  });

  it("cancelar doação one_time: 409 not_a_subscription", async () => {
    await seedStore();
    const token = await customerToken(app, "m7@example.org");
    const res = await app.inject({
      method: "POST",
      url: "/donations",
      headers: { authorization: `Bearer ${token}` },
      payload: { storeSlug: "nucleo-a", provider: "stripe", amountCents: 3000 },
    });
    const donationId = res.json().donation.id as string;

    const cancelRes = await cancelSubscription(app, token, donationId);
    expect(cancelRes.statusCode).toBe(409);
    expect(cancelRes.json().message).toBe("not_a_subscription");
  });

  it("cancelar duas vezes: a segunda é 409 subscription_already_cancelled e não chama o gateway de novo", async () => {
    await seedStore();
    const token = await customerToken(app, "m8@example.org");
    const res = await donateMonthly(app, token);
    const donationId = res.json().donation.id as string;

    const firstCancel = await cancelSubscription(app, token, donationId);
    expect(firstCancel.statusCode).toBe(202);
    const callsAfterFirst = gateways.stripeCancelledSubscriptions.length;

    const secondCancel = await cancelSubscription(app, token, donationId);
    expect(secondCancel.statusCode).toBe(409);
    expect(secondCancel.json().message).toBe("subscription_already_cancelled");
    expect(gateways.stripeCancelledSubscriptions).toHaveLength(callsAfterFirst);
  });

  it("webhook customer.subscription.deleted: subscriptionCancelledAt preenchido mesmo sem a rota ter sido chamada", async () => {
    await seedStore();
    const token = await customerToken(app, "m9@example.org");
    const res = await donateMonthly(app, token);
    const donationId = res.json().donation.id as string;
    const subscriptionId = res.json().payment.subscriptionId as string;

    const webhookRes = await stripeEvent(app, {
      id: "evt_sub_deleted",
      type: "customer.subscription.deleted",
      data: { object: { id: subscriptionId } },
    });
    expect(webhookRes.statusCode).toBe(200);

    const donation = await db.donation.findUniqueOrThrow({ where: { id: donationId } });
    expect(donation.subscriptionCancelledAt).not.toBeNull();
  });
});
