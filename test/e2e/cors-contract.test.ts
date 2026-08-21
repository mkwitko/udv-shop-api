import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

describe("CORS e contrato OpenAPI", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());

  it("preflight de PUT é aceito — existem rotas PUT no app", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/stores/nucleo-demo/connect/woovi",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toContain("PUT");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("todo método usado por alguma rota está liberado no CORS", async () => {
    const allowed = new Set(
      String(
        (
          await app.inject({
            method: "OPTIONS",
            url: "/stores",
            headers: {
              origin: "http://localhost:3000",
              "access-control-request-method": "GET",
            },
          })
        ).headers["access-control-allow-methods"] ?? "",
      )
        .split(",")
        .map((m) => m.trim()),
    );
    const matches = Array.from(
      app.printRoutes({ commonPrefix: false }).matchAll(/\(([A-Z, ]+)\)/g),
    );
    const used = new Set(matches.flatMap((m) => (m[1] ?? "").split(",").map((s) => s.trim())));
    used.delete("HEAD");
    for (const method of used) expect(allowed).toContain(method);
  });

  it("o spec OpenAPI cobre as rotas públicas e as marca sem bearer", async () => {
    const spec = app.swagger() as {
      paths: Record<string, Record<string, { security?: unknown[] }>>;
    };
    expect(Object.keys(spec.paths).length).toBeGreaterThan(20);
    expect(spec.paths["/stores/{slug}"]?.get?.security).toBeUndefined();
    expect(spec.paths["/orders/{id}"]?.get?.security).toEqual([{ bearerAuth: [] }]);
    // Fluxo sem conta: bearer OU nada. O mesmo endpoint atende quem está logado e quem manda
    // só nome e telefone.
    expect(spec.paths["/orders"]?.post?.security).toEqual([{ bearerAuth: [] }, {}]);
    expect(spec.paths["/interests"]?.post?.security).toEqual([{ bearerAuth: [] }, {}]);
    // e o recibo público não tem nem a opção de bearer
    expect(spec.paths["/orders/{id}/receipt"]?.get?.security).toBeUndefined();
  });
});
