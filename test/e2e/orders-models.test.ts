import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";

describe("modelos de orders/payments/webhooks", () => {
  beforeEach(resetDb);

  it("cria grafo order+items+payment e cascateia delete", async () => {
    const user = await db.user.create({
      data: { email: "c@example.org", name: "Cliente", passwordHash: "x" },
    });
    const store = await db.store.create({
      data: { slug: "nucleo-a", name: "Núcleo A", status: "active" },
    });
    const product = await db.product.create({
      data: { storeId: store.id, slug: "mel", name: "Mel", priceCents: 2500, stock: 10 },
    });
    const order = await db.order.create({
      data: {
        storeId: store.id,
        userId: user.id,
        totalCents: 5000,
        contactPhone: "11999990000",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        items: { create: [{ productId: product.id, name: "Mel", priceCents: 2500, qty: 2 }] },
        payment: { create: { provider: "woovi", amountCents: 5000, applicationFeeCents: 250 } },
      },
      include: { items: true, payment: true },
    });
    expect(order.status).toBe("pending_payment");
    expect(order.payment?.status).toBe("pending");
    expect(order.items).toHaveLength(1);

    await db.order.delete({ where: { id: order.id } });
    expect(await db.orderItem.count()).toBe(0);
    expect(await db.payment.count()).toBe(0);
  });

  it("webhook_events dedup por (provider, eventId)", async () => {
    await db.webhookEvent.create({
      data: { provider: "stripe", eventId: "evt_1", type: "x", payload: {} },
    });
    await expect(
      db.webhookEvent.create({
        data: { provider: "stripe", eventId: "evt_1", type: "x", payload: {} },
      }),
    ).rejects.toMatchObject({
      code: "P2002",
    } satisfies Partial<Prisma.PrismaClientKnownRequestError>);
  });
});
