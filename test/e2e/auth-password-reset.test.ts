import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways, type FakeGateways } from "../mocks/gateways.fake.js";

describe("forgot/reset password", () => {
  let app: FastifyInstance;
  let fakes: FakeGateways;
  beforeAll(async () => {
    fakes = buildFakeGateways();
    app = await buildApp({ gateways: fakes });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    fakes.sentEmails.length = 0;
  });

  const user = { name: "Bia", email: "bia@example.org", password: "senha-forte-123" };

  it("forgot devolve 204 para email inexistente (sem vazar)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/forgot-password",
      payload: { email: "ninguem@example.org" },
    });
    expect(res.statusCode).toBe(204);
    expect(fakes.sentEmails).toHaveLength(0);
  });

  it("fluxo completo: forgot → email → reset → login com senha nova; refresh antigo morre", async () => {
    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: user });
    const oldRt = reg.cookies.find((c) => c.name === "udv_rt")?.value ?? "";
    fakes.sentEmails.length = 0;

    await app.inject({
      method: "POST",
      url: "/auth/forgot-password",
      payload: { email: user.email },
    });
    const html = fakes.sentEmails[0]?.html ?? "";
    const token = /token=([A-Za-z0-9_-]+)/.exec(html)?.[1];

    const reset = await app.inject({
      method: "POST",
      url: "/auth/reset-password",
      payload: { token, password: "nova-senha-forte-456" },
    });
    expect(reset.statusCode).toBe(204);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: user.email, password: "nova-senha-forte-456" },
    });
    expect(login.statusCode).toBe(200);

    const refresh = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { udv_rt: oldRt },
    });
    expect(refresh.statusCode).toBe(401);
  });

  it("token de reset não pode ser reusado", async () => {
    await app.inject({ method: "POST", url: "/auth/register", payload: user });
    fakes.sentEmails.length = 0;
    await app.inject({ method: "POST", url: "/auth/forgot-password", payload: { email: user.email } });
    const token = /token=([A-Za-z0-9_-]+)/.exec(fakes.sentEmails[0]?.html ?? "")?.[1];
    await app.inject({
      method: "POST",
      url: "/auth/reset-password",
      payload: { token, password: "nova-senha-forte-456" },
    });
    const again = await app.inject({
      method: "POST",
      url: "/auth/reset-password",
      payload: { token, password: "outra-senha-forte-789" },
    });
    expect(again.statusCode).toBe(401);
  });
});
