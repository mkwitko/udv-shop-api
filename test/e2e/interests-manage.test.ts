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
  // Segunda loja com sua própria demanda: sem o filtro por storeId, tanto a lista
  // quanto a demanda agregada de nucleo-a vazariam essas linhas.
  const otherStore = await db.store.create({
    data: { slug: "nucleo-fora", name: "Núcleo Fora", status: "active" },
  });
  const otherProduct = await db.product.create({
    data: {
      storeId: otherStore.id,
      slug: "produto-fora",
      name: "Produto de outra loja",
      priceCents: 4000,
      availability: "on_demand",
    },
  });
  const otherUser = await db.user.create({
    data: { email: "fora@example.org", name: "Pessoa Fora", passwordHash: "x" },
  });
  await db.productInterest.create({
    data: { productId: otherProduct.id, userId: otherUser.id, qty: 9 },
  });
  return { store, cha, livro, otherStore, otherProduct };
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
    const items = res.json().items;
    // Existem 7 encomendas no banco (6 de nucleo-a + 1 de nucleo-fora); só as 6 da
    // própria loja devem voltar — isso falharia se `product: { storeId }` sumisse
    // de listByStoreCursor.
    expect(await db.productInterest.count()).toBe(7);
    expect(items).toHaveLength(6);
    expect(
      items.some((i: { product: { slug: string } }) => i.product.slug === "produto-fora"),
    ).toBe(false);
  });

  it("lista da loja traz nome e telefone mascarado, nunca o número inteiro", async () => {
    const { store, cha } = await seedDemand();
    const pessoa = await db.user.create({
      data: {
        email: "contato@example.org",
        name: "Maria Silva",
        passwordHash: "x",
        phone: "5548999995678",
      },
    });
    await db.productInterest.create({
      data: { productId: cha.id, userId: pessoa.id, qty: 1 },
    });
    const { token } = await registerWithRole(app, "staff-mask@example.org", store.id, "staff");
    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/interests?limit=50",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const item = res
      .json()
      .items.find((i: { customer: { name: string } }) => i.customer.name === "Maria Silva");
    expect(item.customer).toEqual({
      name: "Maria Silva",
      phoneMasked: "(48) ****-5678",
      phone: null,
    });
    expect(res.payload).not.toContain("999995678");
  });

  // Quem deixou só telefone é avisado por WhatsApp: sem o número inteiro, a loja coleta um
  // dado que não consegue usar. Owner e admin são a mesma fronteira que já pode disparar o
  // aviso de chegada; staff continua no mascarado.
  it("owner vê o telefone completo do interessado", async () => {
    const { store, cha } = await seedDemand();
    const pessoa = await db.user.create({
      data: { name: "Maria Visitante", phone: "5548999995678" },
    });
    await db.productInterest.create({ data: { productId: cha.id, userId: pessoa.id, qty: 1 } });
    const { token } = await registerWithRole(app, "owner-fone@example.org", store.id, "owner");
    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/interests?limit=50",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const item = res
      .json()
      .items.find((i: { customer: { name: string } }) => i.customer.name === "Maria Visitante");
    expect(item.customer.phone).toBe("5548999995678");
    expect(item.customer.phoneMasked).toBe("(48) ****-5678");
  });

  it("admin também vê, staff não", async () => {
    const { store, cha } = await seedDemand();
    const pessoa = await db.user.create({
      data: { name: "Maria Visitante", phone: "5548999995678" },
    });
    await db.productInterest.create({ data: { productId: cha.id, userId: pessoa.id, qty: 1 } });

    const admin = await registerWithRole(app, "admin-fone@example.org", store.id, "admin");
    const asAdmin = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/interests?limit=50",
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(asAdmin.payload).toContain("5548999995678");

    const staff = await registerWithRole(app, "staff-fone@example.org", store.id, "staff");
    const asStaff = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/interests?limit=50",
      headers: { authorization: `Bearer ${staff.token}` },
    });
    expect(asStaff.payload).not.toContain("5548999995678");
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
    // nucleo-fora tem demanda aberta de qty 9 (maior que qualquer uma daqui) — se
    // aparecesse ela liderar-ia o sort por totalQty desc, então isso também prova
    // que `product: { storeId }` em aggregateDemand está de fato filtrando.
    expect(items).toHaveLength(2);
    expect(
      items.some((i: { product: { slug: string } }) => i.product.slug === "produto-fora"),
    ).toBe(false);
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

describe("POST /stores/:slug/products/:productSlug/interests/notify", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("marca os open como notified e enfileira um outbox por interesse", async () => {
    const { store } = await seedDemand();
    const { token } = await registerWithRole(app, "notify@example.org", store.id, "admin");
    const res = await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/products/cha-especial/interests/notify",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ notified: 2 });
    const rows = await db.productInterest.findMany({
      where: { product: { slug: "cha-especial" } },
    });
    expect(rows.filter((r) => r.status === "notified")).toHaveLength(3);
    expect(rows.filter((r) => r.notifiedAt !== null)).toHaveLength(3);
    const events = await db.outboxEvent.findMany({ where: { type: "interest.notified" } });
    expect(events).toHaveLength(2);
  });

  it("notificar duas vezes é no-op na segunda chamada (ADR-014)", async () => {
    const { store } = await seedDemand();
    const { token } = await registerWithRole(app, "notify-idem@example.org", store.id, "admin");
    const first = await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/products/cha-especial/interests/notify",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.json()).toEqual({ notified: 2 });
    const second = await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/products/cha-especial/interests/notify",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.json()).toEqual({ notified: 0 });
    expect(await db.outboxEvent.count({ where: { type: "interest.notified" } })).toBe(2);
  });

  it("sem interesse aberto → notified 0 e nenhum outbox", async () => {
    const { store } = await seedDemand();
    const { token } = await registerWithRole(app, "notify2@example.org", store.id, "admin");
    await db.productInterest.updateMany({
      where: { product: { slug: "cha-especial" } },
      data: { status: "cancelled" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/products/cha-especial/interests/notify",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json()).toEqual({ notified: 0 });
    expect(await db.outboxEvent.count({ where: { type: "interest.notified" } })).toBe(0);
  });

  it("staff não notifica (precisa de admin+) → 403", async () => {
    const { store } = await seedDemand();
    const { token } = await registerWithRole(app, "notify3@example.org", store.id, "staff");
    const res = await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/products/cha-especial/interests/notify",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("loja suspensa → 403 store_suspended", async () => {
    const { store } = await seedDemand();
    const { token } = await registerWithRole(app, "notify4@example.org", store.id, "admin");
    await db.store.update({ where: { id: store.id }, data: { status: "suspended" } });
    const res = await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/products/cha-especial/interests/notify",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("store_suspended");
  });

  it("produto de outra loja → 404", async () => {
    const { store } = await seedDemand();
    const outra = await db.store.create({
      data: { slug: "nucleo-b", name: "Núcleo B", status: "active" },
    });
    await db.product.create({
      data: {
        storeId: outra.id,
        slug: "so-da-outra",
        name: "Só da outra",
        priceCents: 100,
        availability: "on_demand",
      },
    });
    const { token } = await registerWithRole(app, "notify5@example.org", store.id, "admin");
    const res = await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/products/so-da-outra/interests/notify",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe("product_not_found");
  });
});
