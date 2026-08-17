import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../../src/app.js";
import { signAccessToken } from "../../src/lib/jwt.js";
import { requireUser } from "../../src/http/hooks/auth.js";

describe("auth hooks", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    // rota de teste registrada no mesmo escopo de httpRoutes não é possível daqui;
    // então registramos um plugin de teste que reusa os hooks exportados
    const { authHook, permissionsHook } = await import("../../src/http/hooks/auth.js");
    app.register(async (scope) => {
      scope.addHook("preHandler", authHook);
      scope.addHook("preHandler", permissionsHook);
      scope.get(
        "/protegida",
        {
          config: { permissions: { any: ["customer"] } },
          schema: { operationId: "testProtegida", response: { 200: z.object({ sub: z.string() }) } },
        },
        async (req) => ({ sub: requireUser(req).sub }),
      );
      scope.get(
        "/so-admin",
        { config: { permissions: { any: ["platform_admin"] } }, schema: { operationId: "testAdmin" } },
        async () => ({ ok: true }),
      );
      scope.get("/sem-config", { schema: { operationId: "testSemConfig" } }, async () => ({}));
    });
    await app.ready();
  });
  afterAll(() => app.close());

  it("sem token → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/protegida" });
    expect(res.statusCode).toBe(401);
  });

  it("com token → 200 e identidade", async () => {
    const token = await signAccessToken({ id: "u1", platformAdmin: false, roles: {} });
    const res = await app.inject({
      method: "GET",
      url: "/protegida",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sub).toBe("u1");
  });

  it("persona errada → 403", async () => {
    const token = await signAccessToken({ id: "u1", platformAdmin: false, roles: {} });
    const res = await app.inject({
      method: "GET",
      url: "/so-admin",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rota sem permissions declarada → 500", async () => {
    const token = await signAccessToken({ id: "u1", platformAdmin: false, roles: {} });
    const res = await app.inject({
      method: "GET",
      url: "/sem-config",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(500);
  });
});
