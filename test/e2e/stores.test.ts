import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

async function auth(app: FastifyInstance, email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Us", email, password: "senha-forte-123" },
  });
  return {
    token: res.json().accessToken as string,
    cookie: res.cookies.find((c) => c.name === "udv_rt")?.value ?? "",
  };
}

describe("stores", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("cria loja pending com role owner e slug duplicado dá 409", async () => {
    const { token } = await auth(app, "a@example.org");
    const res = await app.inject({
      method: "POST",
      url: "/stores",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Núcleo X", slug: "nucleo-x" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ slug: "nucleo-x", status: "pending" });
    const role = await db.userStoreRole.findFirst({ where: { storeId: res.json().id } });
    expect(role?.role).toBe("owner");

    const dup = await app.inject({
      method: "POST",
      url: "/stores",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Outro", slug: "nucleo-x" },
    });
    expect(dup.statusCode).toBe(409);
  });

  it("lista pública só active, paginada por cursor", async () => {
    for (let i = 0; i < 3; i++) {
      await db.store.create({
        data: {
          slug: `ativa-${i}`,
          name: `A${i}`,
          status: "active",
          createdAt: new Date(Date.now() + i * 1000),
        },
      });
    }
    await db.store.create({ data: { slug: "pendente", name: "P", status: "pending" } });

    const p1 = await app.inject({ method: "GET", url: "/stores?limit=2" });
    expect(p1.statusCode).toBe(200);
    expect(p1.json().items).toHaveLength(2);
    expect(p1.json().nextCursor).toBeTruthy();

    const p2 = await app.inject({
      method: "GET",
      url: `/stores?limit=2&cursor=${p1.json().nextCursor}`,
    });
    expect(p2.json().items).toHaveLength(1);
    expect(p2.json().nextCursor).toBeNull();
    const slugs = [...p1.json().items, ...p2.json().items].map((s: { slug: string }) => s.slug);
    expect(slugs).not.toContain("pendente");
  });

  it("get público: active 200; pending 404 anônimo, 200 pro owner", async () => {
    const { token, cookie } = await auth(app, "b@example.org");
    const created = await app.inject({
      method: "POST",
      url: "/stores",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Pend", slug: "pend" },
    });
    expect(created.statusCode).toBe(201);

    const anon = await app.inject({ method: "GET", url: "/stores/pend" });
    expect(anon.statusCode).toBe(404);

    const refreshed = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { udv_rt: cookie },
    });
    const owner = await app.inject({
      method: "GET",
      url: "/stores/pend",
      headers: { authorization: `Bearer ${refreshed.json().accessToken}` },
    });
    expect(owner.statusCode).toBe(200);
  });

  it("get público: suspensa 200 com status suspended — o link já circulava", async () => {
    await db.store.create({ data: { slug: "fora", name: "Fora do ar", status: "suspended" } });
    const res = await app.inject({ method: "GET", url: "/stores/fora" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ slug: "fora", status: "suspended" });
  });
});
