import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SEED_PASSWORD, SEED_STORE_SLUG, seedDatabase } from "../../prisma/seed.js";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

describe("seed de desenvolvimento", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("roda duas vezes sem duplicar nem quebrar e o resultado é navegável pelo front", async () => {
    await seedDatabase(db);
    await seedDatabase(db);

    expect(await db.store.count()).toBe(1);
    expect(await db.user.count()).toBe(4);
    // 12 produtos de vitrine + 2 eventos da agenda de demonstração
    expect(await db.product.count()).toBe(14);
    expect(await db.product.count({ where: { eventAt: { not: null } } })).toBe(2);
    // gavetas da vitrine, uma delas de propósito vazia
    expect(await db.productCategory.count()).toBe(5);
    // o pedido/doação de exemplo só entra na primeira execução
    expect(await db.order.count()).toBe(1);
    expect(await db.donation.count()).toBe(1);
    expect(await db.raffleEntry.count()).toBe(30);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "dono@nucleo.local", password: SEED_PASSWORD },
    });
    expect(login.statusCode).toBe(200);

    const catalog = await app.inject({ method: "GET", url: `/stores/${SEED_STORE_SLUG}/products` });
    expect(catalog.statusCode).toBe(200);
    // o produto inativo não aparece no catálogo público
    expect(catalog.json().items).toHaveLength(11);

    const orders = await app.inject({
      method: "GET",
      url: `/stores/${SEED_STORE_SLUG}/orders`,
      headers: { authorization: `Bearer ${login.json().accessToken as string}` },
    });
    expect(orders.statusCode).toBe(200);
    expect(orders.json().items).toHaveLength(1);
  });
});
