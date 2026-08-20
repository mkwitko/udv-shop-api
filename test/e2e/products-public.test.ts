import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

describe("catálogo público", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  async function seedStore(status: "active" | "pending" = "active") {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status } });
    for (let i = 0; i < 3; i++) {
      await db.product.create({
        data: {
          storeId: store.id,
          slug: `p-${i}`,
          name: `P${i}`,
          priceCents: 1000 + i,
          createdAt: new Date(Date.now() + i * 1000),
        },
      });
    }
    await db.product.create({
      data: { storeId: store.id, slug: "inativo", name: "I", priceCents: 1, active: false },
    });
    return store;
  }

  it("lista pública pagina e esconde inativos", async () => {
    await seedStore();
    const p1 = await app.inject({ method: "GET", url: "/stores/nx/products?limit=2" });
    expect(p1.statusCode).toBe(200);
    expect(p1.json().items).toHaveLength(2);
    const p2 = await app.inject({
      method: "GET",
      url: `/stores/nx/products?limit=2&cursor=${p1.json().nextCursor}`,
    });
    expect(p2.json().items).toHaveLength(1);
    expect(p2.json().nextCursor).toBeNull();
    const slugs = [...p1.json().items, ...p2.json().items].map((p: { slug: string }) => p.slug);
    expect(slugs).not.toContain("inativo");
  });

  it("loja pending → 404 público", async () => {
    await seedStore("pending");
    const res = await app.inject({ method: "GET", url: "/stores/nx/products" });
    expect(res.statusCode).toBe(404);
  });

  // O resumo do /gestao conta produtos por esta rota para marcar "adicionar um produto".
  // Se ela devolvesse 404 para quem é da loja, o passo ficava pendente para sempre numa
  // loja que ainda não foi publicada — foi o bug relatado em 19/08/2026.
  it("loja pending → membro continua vendo os produtos", async () => {
    const store = await seedStore("pending");
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Dono", email: "dono-pending@example.org", password: "senha-forte-123" },
    });
    const user = await db.user.findUniqueOrThrow({ where: { email: "dono-pending@example.org" } });
    await db.userStoreRole.create({ data: { userId: user.id, storeId: store.id, role: "owner" } });
    const cookie = reg.cookies.find((c) => c.name === "udv_rt")?.value ?? "";
    const refreshed = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { udv_rt: cookie },
    });
    const token = refreshed.json().accessToken as string;

    const res = await app.inject({
      method: "GET",
      url: "/stores/nx/products?limit=1",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThan(0);
  });

  it("all=true com role staff mostra inativos; sem role ignora", async () => {
    const store = await seedStore();
    const anon = await app.inject({ method: "GET", url: "/stores/nx/products?all=true&limit=10" });
    expect(anon.json().items.map((p: { slug: string }) => p.slug)).not.toContain("inativo");

    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "St", email: "s@example.org", password: "senha-forte-123" },
    });
    const user = await db.user.findUniqueOrThrow({ where: { email: "s@example.org" } });
    await db.userStoreRole.create({ data: { userId: user.id, storeId: store.id, role: "staff" } });
    const cookie = reg.cookies.find((c) => c.name === "udv_rt")?.value ?? "";
    const refreshed = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { udv_rt: cookie },
    });

    const withRole = await app.inject({
      method: "GET",
      url: "/stores/nx/products?all=true&limit=10",
      headers: { authorization: `Bearer ${refreshed.json().accessToken}` },
    });
    expect(withRole.json().items.map((p: { slug: string }) => p.slug)).toContain("inativo");
  });

  it("detalhe: ativo 200; inativo 404 público", async () => {
    await seedStore();
    const ok = await app.inject({ method: "GET", url: "/stores/nx/products/p-1" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().slug).toBe("p-1");
    const gone = await app.inject({ method: "GET", url: "/stores/nx/products/inativo" });
    expect(gone.statusCode).toBe(404);
  });

  it("loja suspensa → lista e detalhe 200 (a página pública explica o estado)", async () => {
    const store = await db.store.create({
      data: { slug: "fora", name: "Fora", status: "suspended" },
    });
    await db.product.create({
      data: { storeId: store.id, slug: "caneca", name: "Caneca", priceCents: 2500, stock: 3 },
    });
    const lista = await app.inject({ method: "GET", url: "/stores/fora/products" });
    expect(lista.statusCode).toBe(200);
    expect(lista.json().items).toHaveLength(1);
    const detalhe = await app.inject({ method: "GET", url: "/stores/fora/products/caneca" });
    expect(detalhe.statusCode).toBe(200);
  });
});
