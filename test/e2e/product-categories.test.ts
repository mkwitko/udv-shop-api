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
  const refreshed = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    cookies: { udv_rt: cookie },
  });
  return { token: refreshed.json().accessToken as string, user };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("categorias de produto", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  async function seedTwoStores() {
    const a = await db.store.create({
      data: { slug: "nucleo-a", name: "Núcleo A", status: "active" },
    });
    const b = await db.store.create({
      data: { slug: "nucleo-b", name: "Núcleo B", status: "active" },
    });
    return { a, b };
  }

  describe("criação", () => {
    it("deriva o slug do nome", async () => {
      const { a } = await seedTwoStores();
      const { token } = await registerWithRole(app, "dono-a@example.org", a.id, "owner");

      const res = await app.inject({
        method: "POST",
        url: "/stores/nucleo-a/categories",
        headers: auth(token),
        payload: { name: "Chás e Ervas" },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ slug: "chas-e-ervas", name: "Chás e Ervas", position: 0 });
    });

    it("nome repetido ganha sufixo no slug", async () => {
      const { a } = await seedTwoStores();
      const { token } = await registerWithRole(app, "dono-a@example.org", a.id, "owner");
      const create = (name: string) =>
        app.inject({
          method: "POST",
          url: "/stores/nucleo-a/categories",
          headers: auth(token),
          payload: { name },
        });

      const first = await create("Chás");
      const second = await create("Chás");
      const third = await create("Chás");

      expect(first.json().slug).toBe("chas");
      expect(second.json().slug).toBe("chas-2");
      expect(third.json().slug).toBe("chas-3");
      // ordem de criação vira ordem na vitrine até a loja reordenar
      expect(second.json().position).toBe(1);
      expect(third.json().position).toBe(2);
    });

    it("nome curto é recusado", async () => {
      const { a } = await seedTwoStores();
      const { token } = await registerWithRole(app, "dono-a@example.org", a.id, "owner");
      const res = await app.inject({
        method: "POST",
        url: "/stores/nucleo-a/categories",
        headers: auth(token),
        payload: { name: "x" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("nome só de símbolos não vira slug vazio", async () => {
      const { a } = await seedTwoStores();
      const { token } = await registerWithRole(app, "dono-a@example.org", a.id, "owner");
      const res = await app.inject({
        method: "POST",
        url: "/stores/nucleo-a/categories",
        headers: auth(token),
        payload: { name: "###" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("sem sessão não cria", async () => {
      await seedTwoStores();
      const res = await app.inject({
        method: "POST",
        url: "/stores/nucleo-a/categories",
        payload: { name: "Chás" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("lista pública", () => {
    it("conta só produtos ativos e ordena por position", async () => {
      const { a } = await seedTwoStores();
      const chas = await db.productCategory.create({
        data: { storeId: a.id, slug: "chas", name: "Chás", position: 1 },
      });
      const arte = await db.productCategory.create({
        data: { storeId: a.id, slug: "arte", name: "Artesanato", position: 0 },
      });
      await db.productCategory.create({
        data: { storeId: a.id, slug: "vazia", name: "Vazia", position: 2 },
      });
      await db.product.create({
        data: {
          storeId: a.id,
          slug: "cha-1",
          name: "Chá",
          priceCents: 1000,
          categoryId: chas.id,
        },
      });
      await db.product.create({
        data: {
          storeId: a.id,
          slug: "cha-2",
          name: "Chá arquivado",
          priceCents: 1000,
          categoryId: chas.id,
          active: false,
        },
      });
      await db.product.create({
        data: {
          storeId: a.id,
          slug: "arte-1",
          name: "Cesto",
          priceCents: 2000,
          categoryId: arte.id,
        },
      });

      const res = await app.inject({ method: "GET", url: "/stores/nucleo-a/categories" });

      expect(res.statusCode).toBe(200);
      // total conta a loja inteira, inclusive produto sem gaveta — as somas não batem por acaso
      expect(res.json().total).toBe(2);
      expect(res.json().items).toEqual([
        expect.objectContaining({ slug: "arte", productCount: 1 }),
        expect.objectContaining({ slug: "chas", productCount: 1 }),
        expect.objectContaining({ slug: "vazia", productCount: 0 }),
      ]);
    });

    it("não devolve categoria de outra loja", async () => {
      const { a, b } = await seedTwoStores();
      await db.productCategory.create({
        data: { storeId: a.id, slug: "chas", name: "Chás" },
      });
      await db.productCategory.create({
        data: { storeId: b.id, slug: "secreta", name: "Secreta" },
      });

      const res = await app.inject({ method: "GET", url: "/stores/nucleo-a/categories" });
      const slugs = res.json().items.map((item: { slug: string }) => item.slug);
      expect(slugs).toEqual(["chas"]);
    });

    it("loja pending → 404 público", async () => {
      const store = await db.store.create({
        data: { slug: "rascunho", name: "Rascunho", status: "pending" },
      });
      await db.productCategory.create({
        data: { storeId: store.id, slug: "chas", name: "Chás" },
      });
      const res = await app.inject({ method: "GET", url: "/stores/rascunho/categories" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("renomear", () => {
    it("atualiza nome e slug", async () => {
      const { a } = await seedTwoStores();
      const { token } = await registerWithRole(app, "dono-a@example.org", a.id, "owner");
      const category = await db.productCategory.create({
        data: { storeId: a.id, slug: "chas", name: "Chás" },
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/stores/nucleo-a/categories/${category.id}`,
        headers: auth(token),
        payload: { name: "Chás e Ervas" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: "Chás e Ervas", slug: "chas-e-ervas" });
    });

    it("renomear para nome de outra categoria não colide", async () => {
      const { a } = await seedTwoStores();
      const { token } = await registerWithRole(app, "dono-a@example.org", a.id, "owner");
      await db.productCategory.create({ data: { storeId: a.id, slug: "chas", name: "Chás" } });
      const arte = await db.productCategory.create({
        data: { storeId: a.id, slug: "arte", name: "Artesanato" },
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/stores/nucleo-a/categories/${arte.id}`,
        headers: auth(token),
        payload: { name: "Chás" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().slug).toBe("chas-2");
    });

    it("categoria de outra loja → 404", async () => {
      const { a, b } = await seedTwoStores();
      const { token } = await registerWithRole(app, "dono-a@example.org", a.id, "owner");
      const alheia = await db.productCategory.create({
        data: { storeId: b.id, slug: "secreta", name: "Secreta" },
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/stores/nucleo-a/categories/${alheia.id}`,
        headers: auth(token),
        payload: { name: "Roubada" },
      });

      expect(res.statusCode).toBe(404);
      expect(
        await db.productCategory.findUniqueOrThrow({ where: { id: alheia.id } }),
      ).toMatchObject({ name: "Secreta" });
    });

    it("membro de outra loja não renomeia pela rota da loja dele", async () => {
      const { a, b } = await seedTwoStores();
      const { token } = await registerWithRole(app, "dono-b@example.org", b.id, "owner");
      const category = await db.productCategory.create({
        data: { storeId: a.id, slug: "chas", name: "Chás" },
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/stores/nucleo-a/categories/${category.id}`,
        headers: auth(token),
        payload: { name: "Invadida" },
      });

      expect(res.statusCode).toBe(403);
    });

    it("id que não é uuid → 400, não 500", async () => {
      const { a } = await seedTwoStores();
      const { token } = await registerWithRole(app, "dono-a@example.org", a.id, "owner");
      const res = await app.inject({
        method: "PATCH",
        url: "/stores/nucleo-a/categories/nao-e-uuid",
        headers: auth(token),
        payload: { name: "Chás" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("reordenar", () => {
    it("aplica a ordem enviada", async () => {
      const { a } = await seedTwoStores();
      const { token } = await registerWithRole(app, "dono-a@example.org", a.id, "owner");
      const chas = await db.productCategory.create({
        data: { storeId: a.id, slug: "chas", name: "Chás", position: 0 },
      });
      const arte = await db.productCategory.create({
        data: { storeId: a.id, slug: "arte", name: "Artesanato", position: 1 },
      });

      const res = await app.inject({
        method: "POST",
        url: "/stores/nucleo-a/categories/reorder",
        headers: auth(token),
        payload: { ids: [arte.id, chas.id] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().items.map((item: { slug: string }) => item.slug)).toEqual(["arte", "chas"]);
    });

    it("lista com categoria de outra loja não move nada", async () => {
      const { a, b } = await seedTwoStores();
      const { token } = await registerWithRole(app, "dono-a@example.org", a.id, "owner");
      const chas = await db.productCategory.create({
        data: { storeId: a.id, slug: "chas", name: "Chás", position: 0 },
      });
      const alheia = await db.productCategory.create({
        data: { storeId: b.id, slug: "alheia", name: "Alheia", position: 0 },
      });

      const res = await app.inject({
        method: "POST",
        url: "/stores/nucleo-a/categories/reorder",
        headers: auth(token),
        payload: { ids: [alheia.id, chas.id] },
      });

      expect(res.statusCode).toBe(400);
      expect(
        await db.productCategory.findUniqueOrThrow({ where: { id: alheia.id } }),
      ).toMatchObject({ position: 0 });
      expect(await db.productCategory.findUniqueOrThrow({ where: { id: chas.id } })).toMatchObject({
        position: 0,
      });
    });
  });

  describe("exclusão", () => {
    it("solta os produtos em vez de apagá-los", async () => {
      const { a } = await seedTwoStores();
      const { token } = await registerWithRole(app, "dono-a@example.org", a.id, "owner");
      const chas = await db.productCategory.create({
        data: { storeId: a.id, slug: "chas", name: "Chás" },
      });
      await db.product.create({
        data: { storeId: a.id, slug: "cha", name: "Chá", priceCents: 1000, categoryId: chas.id },
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/stores/nucleo-a/categories/${chas.id}`,
        headers: auth(token),
      });

      expect(res.statusCode).toBe(204);
      const product = await db.product.findFirstOrThrow({ where: { slug: "cha" } });
      expect(product.categoryId).toBeNull();
      expect(product.active).toBe(true);
      expect(await db.productCategory.count()).toBe(0);
    });

    it("categoria de outra loja → 404 e continua existindo", async () => {
      const { a, b } = await seedTwoStores();
      const { token } = await registerWithRole(app, "dono-a@example.org", a.id, "owner");
      const alheia = await db.productCategory.create({
        data: { storeId: b.id, slug: "alheia", name: "Alheia" },
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/stores/nucleo-a/categories/${alheia.id}`,
        headers: auth(token),
      });

      expect(res.statusCode).toBe(404);
      expect(await db.productCategory.count({ where: { id: alheia.id } })).toBe(1);
    });
  });

  describe("produto e categoria", () => {
    it("aceita categoria da própria loja e devolve na resposta", async () => {
      const { a } = await seedTwoStores();
      const { token } = await registerWithRole(app, "dono-a@example.org", a.id, "owner");
      const chas = await db.productCategory.create({
        data: { storeId: a.id, slug: "chas", name: "Chás" },
      });

      const created = await app.inject({
        method: "POST",
        url: "/stores/nucleo-a/products",
        headers: auth(token),
        payload: { name: "Chá verde", slug: "cha-verde", priceCents: 2500, categoryId: chas.id },
      });

      expect(created.statusCode).toBe(201);
      expect(created.json().category).toMatchObject({ slug: "chas", name: "Chás" });
    });

    it("categoria de outra loja → 400 e produto não nasce", async () => {
      const { a, b } = await seedTwoStores();
      const { token } = await registerWithRole(app, "dono-a@example.org", a.id, "owner");
      const alheia = await db.productCategory.create({
        data: { storeId: b.id, slug: "alheia", name: "Alheia" },
      });

      const res = await app.inject({
        method: "POST",
        url: "/stores/nucleo-a/products",
        headers: auth(token),
        payload: { name: "Chá verde", slug: "cha-verde", priceCents: 2500, categoryId: alheia.id },
      });

      expect(res.statusCode).toBe(400);
      expect(await db.product.count()).toBe(0);
    });

    it("update com categoria de outra loja → 400 e nada muda", async () => {
      const { a, b } = await seedTwoStores();
      const { token } = await registerWithRole(app, "dono-a@example.org", a.id, "owner");
      const minha = await db.productCategory.create({
        data: { storeId: a.id, slug: "chas", name: "Chás" },
      });
      const alheia = await db.productCategory.create({
        data: { storeId: b.id, slug: "alheia", name: "Alheia" },
      });
      await db.product.create({
        data: {
          storeId: a.id,
          slug: "cha-verde",
          name: "Chá verde",
          priceCents: 2500,
          categoryId: minha.id,
        },
      });

      const res = await app.inject({
        method: "PATCH",
        url: "/stores/nucleo-a/products/cha-verde",
        headers: auth(token),
        payload: { categoryId: alheia.id },
      });

      expect(res.statusCode).toBe(400);
      const product = await db.product.findFirstOrThrow({ where: { slug: "cha-verde" } });
      expect(product.categoryId).toBe(minha.id);
    });

    it("categoryId null tira o produto da gaveta", async () => {
      const { a } = await seedTwoStores();
      const { token } = await registerWithRole(app, "dono-a@example.org", a.id, "owner");
      const chas = await db.productCategory.create({
        data: { storeId: a.id, slug: "chas", name: "Chás" },
      });
      await db.product.create({
        data: {
          storeId: a.id,
          slug: "cha-verde",
          name: "Chá verde",
          priceCents: 2500,
          categoryId: chas.id,
        },
      });

      const res = await app.inject({
        method: "PATCH",
        url: "/stores/nucleo-a/products/cha-verde",
        headers: auth(token),
        payload: { categoryId: null },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().category).toBeNull();
    });
  });
});
