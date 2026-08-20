import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways, type FakeGateways } from "../mocks/gateways.fake.js";

async function staffToken(
  app: FastifyInstance,
  email: string,
  storeId: string,
  role: "staff" | "admin",
) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Gestor", email, password: "senha-forte-123" },
  });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  await db.userStoreRole.create({ data: { userId: user.id, storeId, role } });
  const cookie = res.cookies.find((c) => c.name === "udv_rt")?.value ?? "";
  const refreshed = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    cookies: { udv_rt: cookie },
  });
  return refreshed.json().accessToken as string;
}

async function seed(orderStatus: "pending_payment" | "paid" = "paid") {
  const buyer = await db.user.create({
    data: { email: "buyer@example.org", name: "Cliente", passwordHash: "x" },
  });
  const store = await db.store.create({
    data: {
      slug: "nucleo-a",
      name: "Núcleo A",
      status: "active",
      stripeAccountId: "acct_1",
      stripeTransfersEnabled: true,
    },
  });
  const product = await db.product.create({
    data: { storeId: store.id, slug: "mel", name: "Mel", priceCents: 2500, stock: 8 },
  });
  const order = await db.order.create({
    data: {
      storeId: store.id,
      userId: buyer.id,
      status: orderStatus,
      totalCents: 5000,
      contactPhone: "11999990000",
      expiresAt: new Date(Date.now() + 60_000),
      items: { create: [{ productId: product.id, name: "Mel", priceCents: 2500, qty: 2 }] },
      payment: {
        create: {
          provider: "stripe",
          providerId: "pi_1",
          amountCents: 5000,
          applicationFeeCents: 250,
          status: orderStatus === "paid" ? "succeeded" : "pending",
        },
      },
    },
  });
  return { store, order, product };
}

describe("gestão de pedidos", () => {
  let app: FastifyInstance;
  let gateways: FakeGateways;
  beforeAll(async () => {
    gateways = buildFakeGateways();
    app = await buildApp({ gateways });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("staff lista pedidos da loja com filtro de status", async () => {
    const { store } = await seed("paid");
    const token = await staffToken(app, "s1@example.org", store.id, "staff");
    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/orders?status=paid",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    const empty = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/orders?status=delivered",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(empty.json().items).toHaveLength(0);
  });

  it("membro de outra loja → 403", async () => {
    const { order } = await seed("paid");
    const outra = await db.store.create({
      data: { slug: "nucleo-b", name: "B", status: "active" },
    });
    const token = await staffToken(app, "s2@example.org", outra.id, "admin");
    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/orders",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    const res2 = await app.inject({
      method: "PATCH",
      url: `/stores/nucleo-a/orders/${order.id}/status`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "delivered" },
    });
    expect(res2.statusCode).toBe(403);
  });

  it("paid → delivery_arranged → delivered; transição inválida → 409", async () => {
    const { store, order } = await seed("paid");
    const token = await staffToken(app, "s3@example.org", store.id, "staff");
    const patch = (status: string) =>
      app.inject({
        method: "PATCH",
        url: `/stores/nucleo-a/orders/${order.id}/status`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status },
      });
    expect((await patch("delivery_arranged")).statusCode).toBe(200);
    expect((await patch("delivery_arranged")).statusCode).toBe(409);
    expect((await patch("delivered")).statusCode).toBe(200);
    const fresh = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("delivered");
  });

  it("admin cancela pending_payment e devolve estoque; staff não pode", async () => {
    const { store, order, product } = await seed("pending_payment");
    const staff = await staffToken(app, "s4@example.org", store.id, "staff");
    const resStaff = await app.inject({
      method: "POST",
      url: `/stores/nucleo-a/orders/${order.id}/cancel`,
      headers: { authorization: `Bearer ${staff}` },
    });
    expect(resStaff.statusCode).toBe(403);
    const admin = await staffToken(app, "s5@example.org", store.id, "admin");
    const res = await app.inject({
      method: "POST",
      url: `/stores/nucleo-a/orders/${order.id}/cancel`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(res.statusCode).toBe(200);
    const fresh = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("cancelled");
    const restocked = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(restocked.stock).toBe(10);
    const again = await app.inject({
      method: "POST",
      url: `/stores/nucleo-a/orders/${order.id}/cancel`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(again.statusCode).toBe(409);
  });

  it("admin pede reembolso de pedido paid → 202 e chama gateway; status muda só via webhook", async () => {
    const { store, order } = await seed("paid");
    const admin = await staffToken(app, "s6@example.org", store.id, "admin");
    const res = await app.inject({
      method: "POST",
      url: `/stores/nucleo-a/orders/${order.id}/refund`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(res.statusCode).toBe(202);
    expect(gateways.stripeRefunds).toContain("pi_1");
    const fresh = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("paid");
  });

  it("dois reembolsos consecutivos → segundo 409 e gateway chamado uma vez só", async () => {
    const { store, order } = await seed("paid");
    const admin = await staffToken(app, "s6b@example.org", store.id, "admin");
    const callsBefore = gateways.stripeRefunds.length;
    const refund = () =>
      app.inject({
        method: "POST",
        url: `/stores/nucleo-a/orders/${order.id}/refund`,
        headers: { authorization: `Bearer ${admin}` },
      });
    const first = await refund();
    expect(first.statusCode).toBe(202);
    const second = await refund();
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      code: "CONFLICT",
      message: "refund_already_requested",
    });
    expect(gateways.stripeRefunds.length - callsBefore).toBe(1);
    const payment = await db.payment.findFirstOrThrow({ where: { orderId: order.id } });
    expect(payment.status).toBe("refund_pending");
  });

  it("refund_pending travado (claim nunca confirmado) é re-reivindicável após o timeout e chega a refunded via webhook; claim fresco → 409 refund_already_requested", async () => {
    const { store, order } = await seed("paid");
    const admin = await staffToken(app, "s6c@example.org", store.id, "admin");
    const payment = await db.payment.findFirstOrThrow({ where: { orderId: order.id } });
    // Simulates a claim that was never confirmed by the webhook (crash/shutdown mid-request):
    // the pre-check used to reject this unconditionally as payment_not_refundable, stranding
    // the payment forever.
    await db.payment.update({
      where: { id: payment.id },
      data: { status: "refund_pending", updatedAt: new Date(Date.now() - 16 * 60_000) },
    });
    const res = await app.inject({
      method: "POST",
      url: `/stores/nucleo-a/orders/${order.id}/refund`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(res.statusCode).toBe(202);
    expect(gateways.stripeRefunds).toContain("pi_1");

    // Immediately re-driven claim is fresh, not stale: a genuine in-flight second call must
    // still be rejected as an in-flight duplicate, not treated as re-drivable.
    const second = await app.inject({
      method: "POST",
      url: `/stores/nucleo-a/orders/${order.id}/refund`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      code: "CONFLICT",
      message: "refund_already_requested",
    });

    const webhookRes = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "ok", "content-type": "application/json" },
      payload: JSON.stringify({
        id: "evt_stale_refund",
        type: "charge.refunded",
        data: { object: { payment_intent: "pi_1" } },
      }),
    });
    expect(webhookRes.statusCode).toBe(200);
    const freshOrder = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(freshOrder.status).toBe("refunded");
    const freshPayment = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(freshPayment.status).toBe("refunded");
  });

  it("reembolso de pedido pending_payment → 409", async () => {
    const { store, order } = await seed("pending_payment");
    const admin = await staffToken(app, "s7@example.org", store.id, "admin");
    const res = await app.inject({
      method: "POST",
      url: `/stores/nucleo-a/orders/${order.id}/refund`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it("loja suspensa bloqueia escrita de gestão → 403 store_suspended", async () => {
    const { store, order } = await seed("paid");
    const admin = await staffToken(app, "s8@example.org", store.id, "admin");
    await db.store.update({ where: { id: store.id }, data: { status: "suspended" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/stores/nucleo-a/orders/${order.id}/status`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { status: "delivered" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("store_suspended");
  });

  it("pedido de outra loja no path desta → 404", async () => {
    const { order } = await seed("paid");
    const outra = await db.store.create({
      data: { slug: "nucleo-b", name: "B", status: "active" },
    });
    const token = await staffToken(app, "s9@example.org", outra.id, "admin");
    const res = await app.inject({
      method: "PATCH",
      url: `/stores/nucleo-b/orders/${order.id}/status`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "delivered" },
    });
    expect(res.statusCode).toBe(404);
  });
});
