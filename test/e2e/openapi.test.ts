import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";

describe("generated OpenAPI spec", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(() => app.close());

  const NO_CONTENT_PATHS: Array<[string, "get" | "post"]> = [
    ["/auth/verify-email", "post"],
    ["/auth/logout", "post"],
    ["/auth/forgot-password", "post"],
    ["/auth/reset-password", "post"],
  ];

  it.each(NO_CONTENT_PATHS)("%s documents a 204 response, not 200", (path, method) => {
    const doc = app.swagger();
    const op = (doc.paths?.[path] as Record<string, { responses?: Record<string, unknown> }>)?.[
      method
    ];
    expect(op?.responses).toBeDefined();
    expect(op?.responses?.["204"]).toBeDefined();
    expect(op?.responses?.["200"]).toBeUndefined();
  });

  it("google start/callback are browser-redirect routes and are hidden from the spec", () => {
    const doc = app.swagger();
    expect(doc.paths?.["/auth/google/start"]).toBeUndefined();
    expect(doc.paths?.["/auth/google/callback"]).toBeUndefined();
  });

  it("protected routes (no config.public) declare bearerAuth security", () => {
    const doc = app.swagger();
    const me = (doc.paths?.["/auth/me"] as Record<string, { security?: unknown }>)?.get;
    expect(me?.security).toEqual([{ bearerAuth: [] }]);
  });

  it("public routes do not declare bearerAuth security", () => {
    const doc = app.swagger();
    const login = (doc.paths?.["/auth/login"] as Record<string, { security?: unknown }>)?.post;
    expect(login?.security).toBeUndefined();
  });
});
