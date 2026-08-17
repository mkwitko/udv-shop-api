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

  it("relayOutbox reclama registro 'processing' com claimedAt velho (crash anterior) e envia o email uma única vez", async () => {
    const { order, user } = await seed(new Date(Date.now() + 60_000));
    await db.order.update({ where: { id: order.id }, data: { status: "paid" } });
    const event = await db.outboxEvent.create({
      data: {
        type: "order.paid",
        payload: { orderId: order.id },
        status: "processing",
        claimedBy: "stale-worker-token",
        claimedAt: new Date(Date.now() - 6 * 60_000),
      },
    });
    const gateways = buildFakeGateways();
    const n = await relayOutbox({ db, email: gateways.email, log: logger });
    expect(n).toBe(1);
    expect(gateways.sentEmails).toHaveLength(1);
    expect(gateways.sentEmails[0]?.to).toBe(user.email);
    const fresh = await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(fresh.status).toBe("processed");
    expect(fresh.claimedBy).toBeNull();
  });

  it("relayOutbox não toca registro 'processing' reivindicado por outro token com claimedAt recente", async () => {
    const { order } = await seed(new Date(Date.now() + 60_000));
    await db.order.update({ where: { id: order.id }, data: { status: "paid" } });
    const event = await db.outboxEvent.create({
      data: {
        type: "order.paid",
        payload: { orderId: order.id },
        status: "processing",
        claimedBy: "other-instance-token",
        claimedAt: new Date(),
      },
    });
    const gateways = buildFakeGateways();
    const n = await relayOutbox({ db, email: gateways.email, log: logger });
    expect(n).toBe(0);
    expect(gateways.sentEmails).toHaveLength(0);
    const fresh = await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(fresh.status).toBe("processing");
    expect(fresh.claimedBy).toBe("other-instance-token");
  });

  it("interest.notified vira email para quem encomendou", async () => {
    const store = await db.store.create({
      data: { slug: "nucleo-a", name: "Núcleo A", status: "active" },
    });
    const product = await db.product.create({
      data: {
        storeId: store.id,
        slug: "cha-especial",
        name: "Chá especial",
        priceCents: 5000,
        availability: "on_demand",
      },
    });
    const user = await db.user.create({
      data: { email: "encomenda@example.org", name: "Cliente", passwordHash: "x" },
    });
    const interest = await db.productInterest.create({
      data: {
        productId: product.id,
        userId: user.id,
        qty: 2,
        status: "notified",
        notifiedAt: new Date(),
      },
    });
    await db.outboxEvent.create({
      data: { type: "interest.notified", payload: { interestId: interest.id } },
    });

    const gateways = buildFakeGateways();
    const processed = await relayOutbox({ db, email: gateways.email, log: logger });

    expect(processed).toBe(1);
    expect(gateways.sentEmails).toHaveLength(1);
    expect(gateways.sentEmails[0]?.to).toBe("encomenda@example.org");
    expect(gateways.sentEmails[0]?.subject).toContain("Chá especial");
    const row = await db.outboxEvent.findFirstOrThrow({ where: { type: "interest.notified" } });
    expect(row.status).toBe("processed");
  });

  it("order.paid converte os interesses do comprador nos produtos do pedido", async () => {
    const store = await db.store.create({
      data: { slug: "nucleo-a", name: "Núcleo A", status: "active" },
    });
    const product = await db.product.create({
      data: {
        storeId: store.id,
        slug: "cha-especial",
        name: "Chá especial",
        priceCents: 5000,
        availability: "on_demand",
      },
    });
    const buyer = await db.user.create({
      data: { email: "comprador@example.org", name: "Comprador", passwordHash: "x" },
    });
    const outro = await db.user.create({
      data: { email: "outro@example.org", name: "Outro", passwordHash: "x" },
    });
    const mine = await db.productInterest.create({
      data: { productId: product.id, userId: buyer.id, qty: 1, status: "notified" },
    });
    const alheio = await db.productInterest.create({
      data: { productId: product.id, userId: outro.id, qty: 1 },
    });
    const order = await db.order.create({
      data: {
        storeId: store.id,
        userId: buyer.id,
        status: "paid",
        totalCents: 5000,
        contactPhone: "11999990000",
        expiresAt: new Date(Date.now() + 60_000),
        items: {
          create: [{ productId: product.id, name: "Chá especial", priceCents: 5000, qty: 1 }],
        },
      },
    });
    await db.outboxEvent.create({ data: { type: "order.paid", payload: { orderId: order.id } } });

    const gateways = buildFakeGateways();
    await relayOutbox({ db, email: gateways.email, log: logger });

    expect((await db.productInterest.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe(
      "converted",
    );
    // Interesse de outra pessoa no mesmo produto continua na fila.
    expect((await db.productInterest.findUniqueOrThrow({ where: { id: alheio.id } })).status).toBe(
      "open",
    );
  });

  it("conversão não reabre interesse cancelado", async () => {
    const store = await db.store.create({
      data: { slug: "nucleo-a", name: "Núcleo A", status: "active" },
    });
    const product = await db.product.create({
      data: {
        storeId: store.id,
        slug: "cha-especial",
        name: "Chá especial",
        priceCents: 5000,
        availability: "on_demand",
      },
    });
    const buyer = await db.user.create({
      data: { email: "comprador2@example.org", name: "Comprador", passwordHash: "x" },
    });
    const cancelled = await db.productInterest.create({
      data: { productId: product.id, userId: buyer.id, qty: 1, status: "cancelled" },
    });
    const order = await db.order.create({
      data: {
        storeId: store.id,
        userId: buyer.id,
        status: "paid",
        totalCents: 5000,
        contactPhone: "11999990000",
        expiresAt: new Date(Date.now() + 60_000),
        items: {
          create: [{ productId: product.id, name: "Chá especial", priceCents: 5000, qty: 1 }],
        },
      },
    });
    await db.outboxEvent.create({ data: { type: "order.paid", payload: { orderId: order.id } } });

    const gateways = buildFakeGateways();
    await relayOutbox({ db, email: gateways.email, log: logger });

    expect(
      (await db.productInterest.findUniqueOrThrow({ where: { id: cancelled.id } })).status,
    ).toBe("cancelled");
  });
});
