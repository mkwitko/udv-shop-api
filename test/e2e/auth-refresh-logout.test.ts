import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

describe("refresh / logout", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  async function registerAndGetCookie() {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Ana", email: "ana@example.org", password: "senha-forte-123" },
    });
    const cookie = res.cookies.find((c) => c.name === "udv_rt");
    if (!cookie) throw new Error("no refresh cookie");
    return cookie.value;
  }

  it("refresh rotaciona cookie e devolve novo access", async () => {
    const rt = await registerAndGetCookie();
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { udv_rt: rt },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTruthy();
    const newCookie = res.cookies.find((c) => c.name === "udv_rt");
    expect(newCookie?.value).not.toBe(rt);
  });

  it("refresh sem cookie → 401", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/refresh" });
    expect(res.statusCode).toBe(401);
  });

  it("logout revoga: refresh subsequente falha", async () => {
    const rt = await registerAndGetCookie();
    const out = await app.inject({ method: "POST", url: "/auth/logout", cookies: { udv_rt: rt } });
    expect(out.statusCode).toBe(204);
    const res = await app.inject({ method: "POST", url: "/auth/refresh", cookies: { udv_rt: rt } });
    expect(res.statusCode).toBe(401);
  });
});
