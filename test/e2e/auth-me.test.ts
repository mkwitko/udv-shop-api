import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

describe("GET /auth/me", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("retorna user autenticado", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Ci", email: "ci@example.org", password: "senha-forte-123" },
    });
    const { accessToken } = reg.json();
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: "ci@example.org", emailVerified: false });
  });

  it("sem token → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/me" });
    expect(res.statusCode).toBe(401);
  });
});
