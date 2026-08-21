import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";

/**
 * O caso real que motivou esta rota: a `DATABASE_URL` de produção subiu corrompida
 * (um `&` no lado de substituição do `sed` colou a linha antiga do .env dentro da query
 * string). O container ficou `healthy`, o `prisma migrate deploy` passou — ele usa outra
 * credencial — e só a primeira requisição de verdade quebrou. Com o healthcheck em
 * /health, o rollback automático do deploy nunca veria essa falha.
 */
describe("GET /health/ready", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(() => app.close());
  afterEach(() => vi.restoreAllMocks());

  it("200 quando o banco responde", async () => {
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", database: "up" });
  });

  it("503 quando a consulta ao banco falha", async () => {
    vi.spyOn(db, "$queryRaw").mockRejectedValueOnce(new Error("connection refused"));
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "degraded", database: "down" });
  });

  it("é pública: não exige autenticação", async () => {
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).not.toBe(401);
  });
});
