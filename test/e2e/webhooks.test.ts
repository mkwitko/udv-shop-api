import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { expireReservations } from "../../src/workers/expire-reservations.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways, type FakeGateways } from "../mocks/gateways.fake.js";

async function customerToken(app: FastifyInstance, email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Cliente", email, password: "senha-forte-123" },
  });
  return res.json().accessToken as string;
}

async function seedOrder(app: FastifyInstance, provider: "stripe" | "woovi") {
  const store = await db.store.create({
    data: {
      slug: "nucleo-a",
      name: "Núcleo A",
      status: "active",
      stripeAccountId: "acct_1",
      stripeTransfersEnabled: true,
      wooviPixKey: "pix@nucleo.org",
    },
  });
  const product = await db.product.create({
    data: { storeId: store.id, slug: "mel", name: "Mel", priceCents: 2500, stock: 10 },
  });
  const token = await customerToken(app, `w-${provider}@example.org`);
  const res = await app.inject({
    method: "POST",
    url: "/orders",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      storeSlug: "nucleo-a",
      provider,
      items: [{ productSlug: "mel", qty: 2 }],
      contactPhone: "11999990000",
    },
  });
  const orderId = res.json().order.id as string;
  const payment = await db.payment.findFirstOrThrow({ where: { orderId } });
  return { orderId, payment, product };
}

function stripeEvent(app: FastifyInstance, event: Record<string, unknown>, signature = "ok") {
  return app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: { "stripe-signature": signature, "content-type": "application/json" },
    payload: JSON.stringify(event),
  });
}

describe("webhooks", () => {
  let app: FastifyInstance;
  let gateways: FakeGateways;
  beforeAll(async () => {
    gateways = buildFakeGateways();
    app = await buildApp({ gateways });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("stripe payment_intent.succeeded → order paid + outbox order.paid", async () => {
    const { orderId, payment } = await seedOrder(app, "stripe");
    const res = await stripeEvent(app, {
      id: "evt_1",
      type: "payment_intent.succeeded",
      data: { object: { id: payment.providerId, metadata: { orderId, paymentId: payment.id } } },
    });
    expect(res.statusCode).toBe(200);
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("paid");
    const fresh = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(fresh.status).toBe("succeeded");
    const outbox = await db.outboxEvent.findFirstOrThrow({ where: { type: "order.paid" } });
    expect(outbox.payload).toMatchObject({ orderId });
    const event = await db.webhookEvent.findFirstOrThrow();
    expect(event.status).toBe("processed");
  });

  it("evento duplicado → 200 e processa uma vez só", async () => {
    const { orderId, payment } = await seedOrder(app, "stripe");
    const body = {
      id: "evt_dup",
      type: "payment_intent.succeeded",
      data: { object: { id: payment.providerId, metadata: { orderId, paymentId: payment.id } } },
    };
    await stripeEvent(app, body);
    const res = await stripeEvent(app, body);
    expect(res.statusCode).toBe(200);
    expect(await db.webhookEvent.count()).toBe(1);
    expect(await db.outboxEvent.count({ where: { type: "order.paid" } })).toBe(1);
  });

  it("assinatura inválida → 401 e nada persiste", async () => {
    await seedOrder(app, "stripe");
    const res = await stripeEvent(
      app,
      { id: "evt_bad", type: "x", data: { object: {} } },
      "invalid",
    );
    expect(res.statusCode).toBe(401);
    expect(await db.webhookEvent.count()).toBe(0);
  });

  it("stripe payment_intent.payment_failed → pedido segue pending_payment, estoque continua reservado (intent é retentável)", async () => {
    const { orderId, payment, product } = await seedOrder(app, "stripe");
    await stripeEvent(app, {
      id: "evt_fail",
      type: "payment_intent.payment_failed",
      data: { object: { id: payment.providerId, metadata: { orderId, paymentId: payment.id } } },
    });
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("pending_payment");
    const fresh = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(fresh.stock).toBe(8);
  });

  it("stripe payment_intent.canceled → cancela e devolve estoque (terminal, ao contrário de payment_failed)", async () => {
    const { orderId, payment, product } = await seedOrder(app, "stripe");
    await stripeEvent(app, {
      id: "evt_cancel",
      type: "payment_intent.canceled",
      data: { object: { id: payment.providerId, metadata: { orderId, paymentId: payment.id } } },
    });
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("cancelled");
    const fresh = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(fresh.stock).toBe(10);
  });

  it("stripe charge.refunded → payment refunded, order refunded", async () => {
    const { orderId, payment } = await seedOrder(app, "stripe");
    await stripeEvent(app, {
      id: "evt_paid",
      type: "payment_intent.succeeded",
      data: { object: { id: payment.providerId, metadata: { orderId, paymentId: payment.id } } },
    });
    const res = await stripeEvent(app, {
      id: "evt_refund",
      type: "charge.refunded",
      data: { object: { payment_intent: payment.providerId } },
    });
    expect(res.statusCode).toBe(200);
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("refunded");
    const fresh = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(fresh.status).toBe("refunded");
  });

  it("woovi OPENPIX:CHARGE_COMPLETED → order paid", async () => {
    const { orderId, payment } = await seedOrder(app, "woovi");
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/woovi",
      headers: { "x-openpix-signature": "ok", "content-type": "application/json" },
      payload: JSON.stringify({
        event: "OPENPIX:CHARGE_COMPLETED",
        charge: { correlationID: payment.id, identifier: payment.providerId },
      }),
    });
    expect(res.statusCode).toBe(200);
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("paid");
  });

  it("woovi assinatura inválida → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/woovi",
      headers: { "x-openpix-signature": "invalid", "content-type": "application/json" },
      payload: JSON.stringify({ event: "x" }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("woovi OPENPIX:TRANSACTION_REFUND_RECEIVED → payment refunded, order refunded", async () => {
    const { orderId, payment } = await seedOrder(app, "woovi");
    await app.inject({
      method: "POST",
      url: "/webhooks/woovi",
      headers: { "x-openpix-signature": "ok", "content-type": "application/json" },
      payload: JSON.stringify({
        event: "OPENPIX:CHARGE_COMPLETED",
        charge: { correlationID: payment.id, identifier: payment.providerId },
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/woovi",
      headers: { "x-openpix-signature": "ok", "content-type": "application/json" },
      payload: JSON.stringify({
        // nome real do evento no catálogo da Woovi (evento de transação, não de cobrança)
        event: "OPENPIX:TRANSACTION_REFUND_RECEIVED",
        charge: { correlationID: payment.id, identifier: payment.providerId },
      }),
    });
    expect(res.statusCode).toBe(200);
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("refunded");
    const fresh = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(fresh.status).toBe("refunded");
  });

  it("woovi OPENPIX:CHARGE_EXPIRED → cancela pedido pendente e devolve estoque", async () => {
    const { orderId, payment, product } = await seedOrder(app, "woovi");
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/woovi",
      headers: { "x-openpix-signature": "ok", "content-type": "application/json" },
      payload: JSON.stringify({
        event: "OPENPIX:CHARGE_EXPIRED",
        charge: { correlationID: payment.id, identifier: payment.providerId },
      }),
    });
    expect(res.statusCode).toBe(200);
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("cancelled");
    const fresh = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(fresh.stock).toBe(10);
  });

  it("pagamento tardio de pedido expirado de verdade: payment succeeded, order fica cancelled, gera sinal payment.orphaned", async () => {
    const { orderId, payment } = await seedOrder(app, "stripe");
    // Drive the real path: expire the reservation for real (not a hand-mutated row) so the
    // payment row ends up "expired", the state production code actually produces.
    await db.order.update({
      where: { id: orderId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const cancelled = await expireReservations({ db });
    expect(cancelled).toBe(1);
    const expiredPayment = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(expiredPayment.status).toBe("expired");

    await stripeEvent(app, {
      id: "evt_late",
      type: "payment_intent.succeeded",
      data: { object: { id: payment.providerId, metadata: { orderId, paymentId: payment.id } } },
    });
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("cancelled");
    const fresh = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(fresh.status).toBe("succeeded");
    expect(await db.outboxEvent.count({ where: { type: "order.paid" } })).toBe(0);
    const orphan = await db.outboxEvent.findFirstOrThrow({ where: { type: "payment.orphaned" } });
    expect(orphan.payload).toMatchObject({ orderId, paymentId: payment.id });
  });

  it("tipo desconhecido → processed sem efeito", async () => {
    await stripeEvent(app, { id: "evt_unk", type: "customer.created", data: { object: {} } });
    const event = await db.webhookEvent.findFirstOrThrow();
    expect(event.status).toBe("processed");
  });
});
