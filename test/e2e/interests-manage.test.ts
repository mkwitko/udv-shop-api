import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

async function registerWithRole(
  app: FastifyInstance,
  email: string,
  storeId: string | null,
  role: "owner" | "admin" | "staff" | null,
) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Pessoa", email, password: "senha-forte-123" },
  });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  const cookie = res.cookies.find((c) => c.name === "udv_rt")?.value ?? "";
  if (storeId && role) {
    await db.userStoreRole.create({ data: { userId: user.id, storeId, role } });
  }
  // Refresh para o access token já carregar roles[storeId].
  const refreshed = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    cookies: { udv_rt: cookie },
  });
  return { token: refreshed.json().accessToken as string, user };
}

async function seedDemand() {
  const store = await db.store.create({
    data: { slug: "nucleo-a", name: "Núcleo A", status: "active" },
  });
  const cha = await db.product.create({
    data: {
      storeId: store.id,
      slug: "cha-especial",
      name: "Chá especial",
      priceCents: 5000,
      availability: "on_demand",
    },
  });
  const livro = await db.product.create({
    data: {
      storeId: store.id,
      slug: "livro",
      name: "Livro",
      priceCents: 9000,
      availability: "on_demand",
    },
  });
  const users = [];
  for (let i = 0; i < 3; i++) {
    users.push(
      await db.user.create({
        data: { email: `d${i}@example.org`, name: `Pessoa ${i}`, passwordHash: "x" },
      }),
    );
  }
  // chá: 2 open (qty 2 + 3) + 1 notified (qty 1) = 3 interesses, 6 unidades
  await db.productInterest.create({
    data: { productId: cha.id, userId: (users[0] as { id: string }).id, qty: 2 },
  });
  await db.productInterest.create({
    data: { productId: cha.id, userId: (users[1] as { id: string }).id, qty: 3 },
  });
  await db.productInterest.create({
    data: {
      productId: cha.id,
      userId: (users[2] as { id: string }).id,
      qty: 1,
      status: "notified",
      notifiedAt: new Date(),
    },
  });
  // livro: 1 open (qty 1) + 1 cancelado (não conta) + 1 convertido (não conta)
  await db.productInterest.create({
    data: { productId: livro.id, userId: (users[0] as { id: string }).id, qty: 1 },
  });
  await db.productInterest.create({
    data: {
      productId: livro.id,
      userId: (users[1] as { id: string }).id,
      qty: 5,
      status: "cancelled",
    },
  });
  await db.productInterest.create({
    data: {
      productId: livro.id,
      userId: (users[2] as { id: string }).id,
      qty: 7,
      status: "converted",
    },
  });
  return { store, cha, livro };
}

describe("gestão de encomendas", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("staff lista os interesses da loja", async () => {
    const { store } = await seedDemand();
    const { token } = await registerWithRole(app, "staff@example.org", store.id, "staff");
    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/interests?limit=50",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(6);
  });

  it("filtra por productSlug e por status", async () => {
    const { store } = await seedDemand();
    const { token } = await registerWithRole(app, "staff2@example.org", store.id, "staff");
    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/interests?productSlug=cha-especial&status=open",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().items).toHaveLength(2);
    const missing = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/interests?productSlug=nao-existe",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().message).toBe("product_not_found");
  });

  it("demanda agregada soma só open e notified, ordenado por quantidade", async () => {
    const { store } = await seedDemand();
    const { token } = await registerWithRole(app, "staff3@example.org", store.id, "staff");
    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/interests/demand",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      product: { slug: "cha-especial", name: "Chá especial" },
      openCount: 2,
      notifiedCount: 1,
      totalQty: 6,
    });
    expect(items[1]).toMatchObject({
      product: { slug: "livro" },
      openCount: 1,
      notifiedCount: 0,
      totalQty: 1,
    });
  });

  it("membro de outra loja → 403", async () => {
    await seedDemand();
    const outra = await db.store.create({
      data: { slug: "nucleo-b", name: "Núcleo B", status: "active" },
    });
    const { token } = await registerWithRole(app, "outra@example.org", outra.id, "owner");
    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/interests",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("cliente sem papel na loja → 403", async () => {
    await seedDemand();
    const { token } = await registerWithRole(app, "cliente@example.org", null, null);
    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/interests/demand",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
