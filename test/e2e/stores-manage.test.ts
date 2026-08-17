import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

async function member(
  app: FastifyInstance,
  email: string,
  storeId: string,
  role: "owner" | "admin" | "staff",
) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Me", email, password: "senha-forte-123" },
  });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  await db.userStoreRole.create({ data: { userId: user.id, storeId, role } });
  const cookie = res.cookies.find((c) => c.name === "udv_rt")?.value ?? "";
  const refreshed = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    cookies: { udv_rt: cookie },
  });
  return refreshed.json().accessToken as string;
}

describe("gestão de loja", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("admin edita; staff → 403", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const admin = await member(app, "adm@example.org", store.id, "admin");
    const staff = await member(app, "stf@example.org", store.id, "staff");

    const ok = await app.inject({
      method: "PATCH",
      url: "/stores/nx",
      headers: { authorization: `Bearer ${admin}` },
      payload: { name: "Novo Nome", branding: { cor: "#224422" } },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().name).toBe("Novo Nome");

    const deny = await app.inject({
      method: "PATCH",
      url: "/stores/nx",
      headers: { authorization: `Bearer ${staff}` },
      payload: { name: "Hack" },
    });
    expect(deny.statusCode).toBe(403);
  });

  it("status: platform_admin ativa; owner comum → 403", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX" } });
    const owner = await member(app, "own@example.org", store.id, "owner");

    const deny = await app.inject({
      method: "PATCH",
      url: "/stores/nx/status",
      headers: { authorization: `Bearer ${owner}` },
      payload: { status: "active" },
    });
    expect(deny.statusCode).toBe(403);

    await db.user.update({ where: { email: "own@example.org" }, data: { platformAdmin: true } });
    const reg = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "own@example.org", password: "senha-forte-123" },
    });
    const ok = await app.inject({
      method: "PATCH",
      url: "/stores/nx/status",
      headers: { authorization: `Bearer ${reg.json().accessToken}` },
      payload: { status: "active" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("active");
  });
});
