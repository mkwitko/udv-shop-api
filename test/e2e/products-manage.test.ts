import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

async function staffToken(app: FastifyInstance, email: string, storeId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "St", email, password: "senha-forte-123" },
  });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  await db.userStoreRole.create({ data: { userId: user.id, storeId, role: "staff" } });
  const cookie = res.cookies.find((c) => c.name === "udv_rt")?.value ?? "";
  const refreshed = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    cookies: { udv_rt: cookie },
  });
  return refreshed.json().accessToken as string;
}

describe("gestão de produtos", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("staff cria produto; slug duplicado 409; imageUrls computado", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const token = await staffToken(app, "s@example.org", store.id);
    const body = {
      name: "Camiseta",
      slug: "camiseta",
      priceCents: 5900,
      images: [`stores/${store.id}/products/img.webp`],
      stock: 10,
    };
    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/products",
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      slug: "camiseta",
      priceCents: 5900,
      availability: "in_stock",
      imageUrls: [`https://cdn.fake/stores/${store.id}/products/img.webp`],
    });

    const dup = await app.inject({
      method: "POST",
      url: "/stores/nx/products",
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect(dup.statusCode).toBe(409);
  });

  it("update parcial e archive", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const token = await staffToken(app, "s2@example.org", store.id);
    await app.inject({
      method: "POST",
      url: "/stores/nx/products",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Caneca", slug: "caneca", priceCents: 2500 },
    });

    const upd = await app.inject({
      method: "PATCH",
      url: "/stores/nx/products/caneca",
      headers: { authorization: `Bearer ${token}` },
      payload: { priceCents: 3000, availability: "on_demand" },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json()).toMatchObject({ priceCents: 3000, availability: "on_demand" });

    const del = await app.inject({
      method: "DELETE",
      url: "/stores/nx/products/caneca",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);
    const row = await db.product.findFirst({ where: { slug: "caneca" } });
    expect(row?.active).toBe(false);
  });

  it("usuário de outra loja → 403", async () => {
    await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const outra = await db.store.create({ data: { slug: "ny", name: "NY", status: "active" } });
    const token = await staffToken(app, "alheio@example.org", outra.id);
    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/products",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Xy", slug: "x-produto", priceCents: 100 },
    });
    expect(res.statusCode).toBe(403);
    expect(await db.product.count()).toBe(0);
  });

  it("loja suspensa → criar produto 403", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "suspended" } });
    const token = await staffToken(app, "susp@example.org", store.id);
    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/products",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Xy", slug: "x-produto", priceCents: 100 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("store_suspended");
  });

  it("loja pending → criar produto continua permitido (201)", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "pending" } });
    const token = await staffToken(app, "pend@example.org", store.id);
    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/products",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Xy", slug: "x-produto", priceCents: 100 },
    });
    expect(res.statusCode).toBe(201);
  });

  it("arquivar e restaurar: o produto volta para a vitrine com o histórico", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const token = await staffToken(app, "restore@example.org", store.id);
    await app.inject({
      method: "POST",
      url: "/stores/nx/products",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Caneca", slug: "caneca", priceCents: 2500, stock: 4 },
    });
    await app.inject({
      method: "DELETE",
      url: "/stores/nx/products/caneca",
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await db.product.findFirstOrThrow({ where: { slug: "caneca" } })).active).toBe(false);

    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/products/caneca/restore",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ slug: "caneca", active: true, stock: 4 });
    expect((await db.product.findFirstOrThrow({ where: { slug: "caneca" } })).active).toBe(true);

    // idempotente: restaurar de novo não é erro
    const again = await app.inject({
      method: "POST",
      url: "/stores/nx/products/caneca/restore",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(again.statusCode).toBe(200);
  });

  it("restaurar em loja suspensa → 403; produto inexistente → 404", async () => {
    const store = await db.store.create({
      data: { slug: "nx", name: "NX", status: "suspended" },
    });
    const token = await staffToken(app, "restore2@example.org", store.id);
    await db.product.create({
      data: { storeId: store.id, slug: "caneca", name: "Caneca", priceCents: 100, active: false },
    });
    const susp = await app.inject({
      method: "POST",
      url: "/stores/nx/products/caneca/restore",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(susp.statusCode).toBe(403);

    await db.store.update({ where: { id: store.id }, data: { status: "active" } });
    const missing = await app.inject({
      method: "POST",
      url: "/stores/nx/products/nao-existe/restore",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.statusCode).toBe(404);
  });
});
