import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

async function registerAndToken(app: FastifyInstance, email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Teste", email, password: "senha-forte-123" },
  });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  return {
    accessToken: res.json().accessToken as string,
    user,
    cookie: res.cookies.find((c) => c.name === "udv_rt")?.value ?? "",
  };
}

describe("POST /uploads/presign", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("staff da loja recebe presigned url", async () => {
    const { user, cookie } = await registerAndToken(app, "s@example.org");
    const store = await db.store.create({ data: { slug: "nucleo-x", name: "Núcleo X" } });
    await db.userStoreRole.create({ data: { userId: user.id, storeId: store.id, role: "staff" } });
    const refreshed = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { udv_rt: cookie },
    });
    const token = refreshed.json().accessToken;

    const res = await app.inject({
      method: "POST",
      url: "/uploads/presign",
      headers: { authorization: `Bearer ${token}` },
      payload: { storeSlug: "nucleo-x", contentType: "image/webp" },
    });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.key).toMatch(new RegExp(`^stores/${store.id}/products/[0-9a-f-]+\\.webp$`));
    expect(json.uploadUrl).toContain(json.key);
    expect(json.publicUrl).toBe(`https://cdn.fake/${json.key}`);
  });

  it("membro de OUTRA loja → 403", async () => {
    const { user, cookie } = await registerAndToken(app, "outra@example.org");
    await db.store.create({ data: { slug: "nucleo-x", name: "X" } });
    const outra = await db.store.create({ data: { slug: "nucleo-y", name: "Y" } });
    await db.userStoreRole.create({ data: { userId: user.id, storeId: outra.id, role: "owner" } });
    const refreshed = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { udv_rt: cookie },
    });

    const res = await app.inject({
      method: "POST",
      url: "/uploads/presign",
      headers: { authorization: `Bearer ${refreshed.json().accessToken}` },
      payload: { storeSlug: "nucleo-x", contentType: "image/webp" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("contentType fora da whitelist → 400", async () => {
    const { user, cookie } = await registerAndToken(app, "s2@example.org");
    const store = await db.store.create({ data: { slug: "nucleo-x", name: "X" } });
    await db.userStoreRole.create({ data: { userId: user.id, storeId: store.id, role: "staff" } });
    const refreshed = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { udv_rt: cookie },
    });
    const res = await app.inject({
      method: "POST",
      url: "/uploads/presign",
      headers: { authorization: `Bearer ${refreshed.json().accessToken}` },
      payload: { storeSlug: "nucleo-x", contentType: "application/pdf" },
    });
    expect(res.statusCode).toBe(400);
  });
});
