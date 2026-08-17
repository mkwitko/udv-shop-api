import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

async function register(app: FastifyInstance, email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Cliente", email, password: "senha-forte-123" },
  });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  return { token: res.json().accessToken as string, user };
}

async function seedOrders(userId: string, count: number) {
  const store =
    (await db.store.findUnique({ where: { slug: "nucleo-a" } })) ??
    (await db.store.create({ data: { slug: "nucleo-a", name: "Núcleo A", status: "active" } }));
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const order = await db.order.create({
      data: {
        storeId: store.id,
        userId,
        totalCents: 1000 + i,
        contactPhone: "11999990000",
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(Date.now() - i * 1000),
      },
    });
    ids.push(order.id);
  }
  return ids;
}

describe("meus pedidos", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("lista paginada só com os meus", async () => {
    const { token, user } = await register(app, "a@example.org");
    const { user: other } = await register(app, "b@example.org");
    await seedOrders(user.id, 3);
    await seedOrders(other.id, 1);
    const res = await app.inject({
      method: "GET",
      url: "/orders?limit=2",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const page = res.json();
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const res2 = await app.inject({
      method: "GET",
      url: `/orders?limit=2&cursor=${page.nextCursor}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res2.json().items).toHaveLength(1);
    expect(res2.json().nextCursor).toBeNull();
  });

  it("detalhe do meu pedido; pedido de outro → 404", async () => {
    const { token, user } = await register(app, "c@example.org");
    const { user: other } = await register(app, "d@example.org");
    const [mine] = await seedOrders(user.id, 1);
    const res = await app.inject({
      method: "GET",
      url: `/orders/${mine}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(mine);

    const store = await db.store.findFirstOrThrow();
    const theirs = await db.order.create({
      data: {
        storeId: store.id,
        userId: other.id,
        totalCents: 500,
        contactPhone: "11999990000",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const res404 = await app.inject({
      method: "GET",
      url: `/orders/${theirs.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res404.statusCode).toBe(404);
  });

  it("cursor malformado → 400", async () => {
    const { token } = await register(app, "e@example.org");
    const res = await app.inject({
      method: "GET",
      url: "/orders?cursor=%%%",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
