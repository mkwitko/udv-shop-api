import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/infra/db/client.js";
import { logger } from "../../src/infra/observability/logger.js";
import { expireReservations } from "../../src/workers/expire-reservations.js";
import { relayOutbox } from "../../src/workers/outbox-relay.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

async function seed(expiresAt: Date) {
  const user = await db.user.create({
    data: { email: "w@example.org", name: "Cliente", passwordHash: "x" },
  });
  const store = await db.store.create({
    data: { slug: "nucleo-a", name: "Núcleo A", status: "active" },
  });
  const product = await db.product.create({
    data: { storeId: store.id, slug: "mel", name: "Mel", priceCents: 2500, stock: 8 },
  });
  const order = await db.order.create({
    data: {
      storeId: store.id,
      userId: user.id,
      totalCents: 5000,
      contactPhone: "11999990000",
      expiresAt,
      items: { create: [{ productId: product.id, name: "Mel", priceCents: 2500, qty: 2 }] },
      payment: { create: { provider: "woovi", amountCents: 5000, applicationFeeCents: 250 } },
    },
  });
  return { user, order, product };
}

describe("workers", () => {
  beforeEach(resetDb);

  it("expireReservations cancela pedido vencido e devolve estoque", async () => {
    const { order, product } = await seed(new Date(Date.now() - 60_000));
    const n = await expireReservations({ db });
    expect(n).toBe(1);
    const fresh = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("cancelled");
    const payment = await db.payment.findFirstOrThrow({ where: { orderId: order.id } });
    expect(payment.status).toBe("expired");
    const restocked = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(restocked.stock).toBe(10);
  });

  it("expireReservations ignora pedido dentro do prazo", async () => {
    await seed(new Date(Date.now() + 60_000));
    expect(await expireReservations({ db })).toBe(0);
  });

  it("relayOutbox envia email de confirmação para order.paid e marca processed", async () => {
    const { order, user } = await seed(new Date(Date.now() + 60_000));
    await db.order.update({ where: { id: order.id }, data: { status: "paid" } });
    await db.outboxEvent.create({ data: { type: "order.paid", payload: { orderId: order.id } } });
    const gateways = buildFakeGateways();
    const n = await relayOutbox({ db, email: gateways.email, log: logger });
    expect(n).toBe(1);
    expect(gateways.sentEmails).toHaveLength(1);
    expect(gateways.sentEmails[0]?.to).toBe(user.email);
    expect(gateways.sentEmails[0]?.subject).toContain("Pagamento confirmado");
    const event = await db.outboxEvent.findFirstOrThrow();
    expect(event.status).toBe("processed");
  });

  it("relayOutbox: erro incrementa attempts e marca failed após 5", async () => {
    const { order } = await seed(new Date(Date.now() + 60_000));
    await db.outboxEvent.create({
      data: { type: "order.paid", payload: { orderId: order.id }, attempts: 4 },
    });
    const gateways = buildFakeGateways({
      email: {
        async send() {
          throw new Error("smtp down");
        },
      },
    });
    await relayOutbox({ db, email: gateways.email, log: logger });
    const event = await db.outboxEvent.findFirstOrThrow();
    expect(event.attempts).toBe(5);
    expect(event.status).toBe("failed");
  });
});
