import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

async function register(app: FastifyInstance, email: string, platformAdmin = false) {
  await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Me", email, password: "senha-forte-123" },
  });
  if (platformAdmin) {
    await db.user.update({ where: { email }, data: { platformAdmin: true } });
  }
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password: "senha-forte-123" },
  });
  return login.json() as { accessToken: string; user: { platformAdmin: boolean } };
}

describe("lista admin de lojas", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("login expõe platformAdmin no payload do usuário", async () => {
    const admin = await register(app, "plat@example.org", true);
    const comum = await register(app, "comum@example.org");
    expect(admin.user.platformAdmin).toBe(true);
    expect(comum.user.platformAdmin).toBe(false);

    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(me.json().platformAdmin).toBe(true);
  });

  it("platform_admin vê todas as lojas, inclusive pendentes e suspensas", async () => {
    await db.store.createMany({
      data: [
        { slug: "ativa", name: "Ativa", status: "active" },
        { slug: "pendente", name: "Pendente", status: "pending" },
        { slug: "suspensa", name: "Suspensa", status: "suspended" },
      ],
    });
    const admin = await register(app, "plat@example.org", true);

    const res = await app.inject({
      method: "GET",
      url: "/admin/stores",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const slugs = res.json().items.map((s: { slug: string }) => s.slug);
    expect(slugs).toEqual(expect.arrayContaining(["ativa", "pendente", "suspensa"]));
    expect(slugs).toHaveLength(3);
  });

  it("filtro por status devolve só as daquele status", async () => {
    await db.store.createMany({
      data: [
        { slug: "ativa", name: "Ativa", status: "active" },
        { slug: "suspensa", name: "Suspensa", status: "suspended" },
      ],
    });
    const admin = await register(app, "plat@example.org", true);

    const res = await app.inject({
      method: "GET",
      url: "/admin/stores?status=suspended",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((s: { slug: string }) => s.slug)).toEqual(["suspensa"]);
  });

  it("pagina por cursor sem repetir nem pular", async () => {
    await db.store.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        slug: `loja-${i}`,
        name: `Loja ${i}`,
        status: "pending" as const,
      })),
    });
    const admin = await register(app, "plat@example.org", true);

    const p1 = await app.inject({
      method: "GET",
      url: "/admin/stores?limit=3",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const page1 = p1.json();
    expect(page1.items).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();

    const p2 = await app.inject({
      method: "GET",
      url: `/admin/stores?limit=3&cursor=${encodeURIComponent(page1.nextCursor)}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const page2 = p2.json();
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();

    const all = [...page1.items, ...page2.items].map((s: { id: string }) => s.id);
    expect(new Set(all).size).toBe(5);
  });

  it("dono de loja sem platform_admin → 403; anônimo → 401", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const owner = await register(app, "own@example.org");
    const user = await db.user.findUniqueOrThrow({ where: { email: "own@example.org" } });
    await db.userStoreRole.create({ data: { userId: user.id, storeId: store.id, role: "owner" } });

    const deny = await app.inject({
      method: "GET",
      url: "/admin/stores",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(deny.statusCode).toBe(403);

    const anon = await app.inject({ method: "GET", url: "/admin/stores" });
    expect(anon.statusCode).toBe(401);
  });
});
