import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

async function auth(app: FastifyInstance, email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Us", email, password: "senha-forte-123" },
  });
  return res.json().accessToken as string;
}

async function createStore(app: FastifyInstance, token: string, slug: string) {
  const res = await app.inject({
    method: "POST",
    url: "/stores",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: `Loja ${slug}`, slug },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe("GET /me/stores", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("lista a loja pending do dono com o papel, que a lista pública não mostra", async () => {
    const token = await auth(app, "dono@example.org");
    await createStore(app, token, "nucleo-alfa");

    const mine = await app.inject({
      method: "GET",
      url: "/me/stores",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().items).toHaveLength(1);
    expect(mine.json().items[0]).toMatchObject({
      slug: "nucleo-alfa",
      status: "pending",
      role: "owner",
    });

    const publicList = await app.inject({ method: "GET", url: "/stores" });
    expect(publicList.json().items).toHaveLength(0);
  });

  it("não vaza loja de outro usuário nem campo sensível", async () => {
    const dono = await auth(app, "dono2@example.org");
    await createStore(app, dono, "nucleo-beta");
    const estranho = await auth(app, "estranho@example.org");

    const res = await app.inject({
      method: "GET",
      url: "/me/stores",
      headers: { authorization: `Bearer ${estranho}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);

    const doDono = await app.inject({
      method: "GET",
      url: "/me/stores",
      headers: { authorization: `Bearer ${dono}` },
    });
    const body = JSON.stringify(doDono.json());
    for (const leak of ["applicationFeeBps", "stripeAccountId", "wooviPixKey"]) {
      expect(body).not.toContain(leak);
    }
  });

  it("exige autenticação", async () => {
    const res = await app.inject({ method: "GET", url: "/me/stores" });
    expect(res.statusCode).toBe(401);
  });
});
