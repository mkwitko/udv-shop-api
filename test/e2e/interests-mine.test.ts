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

async function seedStoreWithProducts() {
  const store = await db.store.create({
    data: { slug: "nucleo-a", name: "Núcleo A", status: "active" },
  });
  const onDemand = await db.product.create({
    data: {
      storeId: store.id,
      slug: "cha-especial",
      name: "Chá especial",
      priceCents: 5000,
      availability: "on_demand",
    },
  });
  const inStock = await db.product.create({
    data: {
      storeId: store.id,
      slug: "camiseta",
      name: "Camiseta",
      priceCents: 8000,
      stock: 5,
      availability: "in_stock",
    },
  });
  return { store, onDemand, inStock };
}

describe("POST /interests", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("cria interesse em produto on_demand", async () => {
    const { token } = await register(app, "a@example.org");
    await seedStoreWithProducts();
    const res = await app.inject({
      method: "POST",
      url: "/interests",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        storeSlug: "nucleo-a",
        productSlug: "cha-especial",
        qty: 2,
        note: "de preferência o de 200g",
      },
    });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.status).toBe("open");
    expect(json.qty).toBe(2);
    expect(json.note).toBe("de preferência o de 200g");
    expect(json.notifiedAt).toBeNull();
    expect(json.product).toMatchObject({ slug: "cha-especial", name: "Chá especial" });
    expect(json.store).toMatchObject({ slug: "nucleo-a", name: "Núcleo A" });
  });

  it("repetir o POST atualiza qty e reabre em vez de duplicar", async () => {
    const { token, user } = await register(app, "b@example.org");
    const { onDemand } = await seedStoreWithProducts();
    const payload = { storeSlug: "nucleo-a", productSlug: "cha-especial", qty: 1 };
    await app.inject({
      method: "POST",
      url: "/interests",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    await db.productInterest.updateMany({
      where: { productId: onDemand.id, userId: user.id },
      data: { status: "notified", notifiedAt: new Date() },
    });
    const res = await app.inject({
      method: "POST",
      url: "/interests",
      headers: { authorization: `Bearer ${token}` },
      payload: { ...payload, qty: 3 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().qty).toBe(3);
    expect(res.json().status).toBe("open");
    expect(res.json().notifiedAt).toBeNull();
    expect(await db.productInterest.count()).toBe(1);
  });

  it("produto in_stock → 400 product_not_on_demand", async () => {
    const { token } = await register(app, "c@example.org");
    await seedStoreWithProducts();
    const res = await app.inject({
      method: "POST",
      url: "/interests",
      headers: { authorization: `Bearer ${token}` },
      payload: { storeSlug: "nucleo-a", productSlug: "camiseta", qty: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("product_not_on_demand");
  });

  it("produto arquivado → 404", async () => {
    const { token } = await register(app, "d@example.org");
    const { onDemand } = await seedStoreWithProducts();
    await db.product.update({ where: { id: onDemand.id }, data: { active: false } });
    const res = await app.inject({
      method: "POST",
      url: "/interests",
      headers: { authorization: `Bearer ${token}` },
      payload: { storeSlug: "nucleo-a", productSlug: "cha-especial", qty: 1 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe("product_not_found");
  });

  it("loja suspensa → 404 store_not_found", async () => {
    const { token } = await register(app, "e@example.org");
    const { store } = await seedStoreWithProducts();
    await db.store.update({ where: { id: store.id }, data: { status: "suspended" } });
    const res = await app.inject({
      method: "POST",
      url: "/interests",
      headers: { authorization: `Bearer ${token}` },
      payload: { storeSlug: "nucleo-a", productSlug: "cha-especial", qty: 1 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe("store_not_found");
  });

  it("sem token → 401", async () => {
    await seedStoreWithProducts();
    const res = await app.inject({
      method: "POST",
      url: "/interests",
      payload: { storeSlug: "nucleo-a", productSlug: "cha-especial", qty: 1 },
    });
    expect(res.statusCode).toBe(401);
  });
});
