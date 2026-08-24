import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

const CONTACT = { name: "Maria Silva", phone: "(11) 98888-7777" };

async function seedStore() {
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
  return { store, product };
}

describe("POST /interests sem conta", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("cria interesse com nome e telefone, sem e-mail", async () => {
    await seedStore();
    const res = await app.inject({
      method: "POST",
      url: "/interests",
      payload: { storeSlug: "nucleo-a", productSlug: "cha-especial", qty: 2, contact: CONTACT },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().qty).toBe(2);
    const user = await db.user.findUniqueOrThrow({ where: { phone: "5511988887777" } });
    expect(user.email).toBeNull();
    expect(user.passwordHash).toBeNull();
    expect(user.name).toBe("Maria Silva");
  });

  it("reaproveita a conta leve quando a mesma pessoa volta", async () => {
    const { product } = await seedStore();
    const payload = { storeSlug: "nucleo-a", productSlug: "cha-especial", contact: CONTACT };
    await app.inject({ method: "POST", url: "/interests", payload });
    const res = await app.inject({
      method: "POST",
      url: "/interests",
      payload: { ...payload, qty: 3 },
    });
    expect(res.statusCode).toBe(201);
    expect(await db.user.count()).toBe(1);
    expect(await db.interest.count({ where: { productId: product.id } })).toBe(1);
  });

  it("sem contato e sem token exige login", async () => {
    await seedStore();
    const res = await app.inject({
      method: "POST",
      url: "/interests",
      payload: { storeSlug: "nucleo-a", productSlug: "cha-especial" },
    });
    expect(res.statusCode).toBe(401);
  });

  // Rota pública com sessão opcional: quem chega logado continua sendo ele mesmo em vez de
  // virar uma conta leve nova — mas um token que não vale ainda é 401, e não "visitante".
  it("Bearer inválido não vira convidado", async () => {
    await seedStore();
    const res = await app.inject({
      method: "POST",
      url: "/interests",
      headers: { authorization: "Bearer token-que-nao-vale" },
      payload: { storeSlug: "nucleo-a", productSlug: "cha-especial", contact: CONTACT },
    });
    expect(res.statusCode).toBe(401);
    expect(await db.user.count()).toBe(0);
  });

  it("sessão vence o contato do formulário", async () => {
    await seedStore();
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Membro", email: "membro@example.org", password: "senha-forte-123" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/interests",
      headers: { authorization: `Bearer ${registered.json().accessToken}` },
      payload: { storeSlug: "nucleo-a", productSlug: "cha-especial", contact: CONTACT },
    });
    expect(res.statusCode).toBe(201);
    // nenhuma conta leve nasceu, e o interesse é do membro
    expect(await db.user.count()).toBe(1);
    const interest = await db.interest.findFirstOrThrow();
    const membro = await db.user.findUniqueOrThrow({ where: { email: "membro@example.org" } });
    expect(interest.userId).toBe(membro.id);
  });

  it("telefone inválido é recusado", async () => {
    await seedStore();
    const res = await app.inject({
      method: "POST",
      url: "/interests",
      payload: {
        storeSlug: "nucleo-a",
        productSlug: "cha-especial",
        contact: { name: "Maria Silva", phone: "98888" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(await db.user.count()).toBe(0);
  });

  it("não devolve a anotação de quem já era interessado", async () => {
    const { product } = await seedStore();
    const membro = await db.user.create({
      data: { name: "Membro", email: "membro@example.org", passwordHash: "hash" },
    });
    await db.interest.create({
      data: { productId: product.id, userId: membro.id, qty: 1, note: "segredo do membro" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/interests",
      payload: {
        storeSlug: "nucleo-a",
        productSlug: "cha-especial",
        contact: { ...CONTACT, email: "membro@example.org" },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().note).toBeNull();
    // e o cadastro de quem tem senha não é reescrito pelo formulário do convidado
    expect((await db.user.findUniqueOrThrow({ where: { id: membro.id } })).phone).toBeNull();
  });
});
