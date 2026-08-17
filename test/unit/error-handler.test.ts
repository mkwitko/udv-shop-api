import { Writable } from "node:stream";
import Fastify from "fastify";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { errorHandlerPlugin } from "../../src/http/plugins/error-handler.js";
import { AppError, NotFoundError } from "../../src/shared/errors.js";

function buildTestApp() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const loggerInstance = pino({ level: "info" }, stream);
  const app = Fastify({ loggerInstance });
  return { app, lines };
}

function errorLogEntries(lines: string[]): unknown[] {
  return lines.map((l) => JSON.parse(l)).filter((entry) => entry.level === 50);
}

describe("error handler plugin", () => {
  it("404 not-found handler includes trace_id", async () => {
    const { app } = buildTestApp();
    await app.register(errorHandlerPlugin);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/nope" });
    const body = res.json();

    expect(res.statusCode).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
    expect(typeof body.trace_id).toBe("string");
    expect(body.trace_id.length).toBeGreaterThan(0);
  });

  it("AppError (4xx) includes trace_id and does not log", async () => {
    const { app, lines } = buildTestApp();
    await app.register(errorHandlerPlugin);
    app.get("/boom", () => {
      throw new NotFoundError("thing_not_found");
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/boom" });
    const body = res.json();

    expect(res.statusCode).toBe(404);
    expect(body).toMatchObject({ code: "NOT_FOUND", message: "thing_not_found" });
    expect(typeof body.trace_id).toBe("string");
    expect(errorLogEntries(lines)).toHaveLength(0);
  });

  it("AppError (5xx, e.g. AUTH_NO_PERMISSIONS) is logged and includes trace_id", async () => {
    const { app, lines } = buildTestApp();
    await app.register(errorHandlerPlugin);
    app.get("/no-permissions", () => {
      throw new AppError("AUTH_NO_PERMISSIONS", 500, "route declared no permissions");
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/no-permissions" });
    const body = res.json();

    expect(res.statusCode).toBe(500);
    expect(body).toMatchObject({ code: "AUTH_NO_PERMISSIONS" });
    expect(typeof body.trace_id).toBe("string");

    const errors = errorLogEntries(lines);
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).toContain("AUTH_NO_PERMISSIONS");
  });

  it("validation errors include trace_id", async () => {
    const { app } = buildTestApp();
    await app.register(errorHandlerPlugin);
    app.get("/validate", () => {
      const err = new Error("bad input") as Error & { validation: unknown };
      err.validation = [{ message: "must be string" }];
      throw err;
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/validate" });
    const body = res.json();

    expect(res.statusCode).toBe(400);
    expect(body.code).toBe("VALIDATION");
    expect(typeof body.trace_id).toBe("string");
  });

  it("unknown 500 errors are logged and include trace_id", async () => {
    const { app, lines } = buildTestApp();
    await app.register(errorHandlerPlugin);
    app.get("/crash", () => {
      throw new Error("unexpected");
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/crash" });
    const body = res.json();

    expect(res.statusCode).toBe(500);
    expect(body).toMatchObject({ code: "INTERNAL", message: "internal_server_error" });
    expect(typeof body.trace_id).toBe("string");
    expect(errorLogEntries(lines).length).toBeGreaterThan(0);
  });

  it("http errors (non-AppError, non-validation, <500) include trace_id", async () => {
    const { app } = buildTestApp();
    await app.register(errorHandlerPlugin);
    app.get("/teapot", () => {
      const err = new Error("i am a teapot") as Error & { statusCode: number };
      err.statusCode = 418;
      throw err;
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/teapot" });
    const body = res.json();

    expect(res.statusCode).toBe(418);
    expect(body.code).toBe("HTTP_ERROR");
    expect(typeof body.trace_id).toBe("string");
  });
});
