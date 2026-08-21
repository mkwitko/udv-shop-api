import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways, type FakeGateways } from "../mocks/gateways.fake.js";

describe("register / verify-email / login", () => {
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

  const body = { name: "Maria", email: "maria@example.org", password: "senha-forte-123" };

  it("register cria user, manda email de verificação, retorna tokens", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/register", payload: body });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.accessToken).toBeTruthy();
    expect(json.user).toMatchObject({ email: body.email, emailVerified: false });
    expect(res.cookies.find((c) => c.name === "udv_rt")).toBeTruthy();
    expect(fakes.sentEmails).toHaveLength(1);
    expect(fakes.sentEmails[0]?.to).toBe(body.email);
  });

  it("email duplicado → 409", async () => {
    await app.inject({ method: "POST", url: "/auth/register", payload: body });
    const res = await app.inject({ method: "POST", url: "/auth/register", payload: body });
    expect(res.statusCode).toBe(409);
  });

  // Conta leve nasce quando alguém pede aviso, doa ou compra sem conta. Se o registro
  // recusasse esse e-mail, quem usou o próprio endereço num fluxo de convidado ficaria
  // trancado fora do próprio cadastro.
  it("adota conta leve criada num fluxo sem conta", async () => {
    const guest = await db.user.create({
      data: { name: "Maria", email: body.email, phone: "5511988887777" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { ...body, name: "Maria Silva" },
    });
    expect(res.statusCode).toBe(201);
    const updated = await db.user.findUniqueOrThrow({ where: { id: guest.id } });
    expect(updated.passwordHash).not.toBeNull();
    expect(updated.name).toBe("Maria Silva");
    // o telefone e o histórico da pessoa continuam onde estavam
    expect(updated.phone).toBe("5511988887777");
    expect(await db.user.count()).toBe(1);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: body.email, password: body.password },
    });
    expect(login.statusCode).toBe(200);
  });

  it("conta com senha continua recusando registro repetido", async () => {
    await app.inject({ method: "POST", url: "/auth/register", payload: body });
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { ...body, name: "Outra", password: "outra-senha-456" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("verify-email marca verificado", async () => {
    await app.inject({ method: "POST", url: "/auth/register", payload: body });
    const html = fakes.sentEmails[0]?.html ?? "";
    const token = /token=([A-Za-z0-9_-]+)/.exec(html)?.[1];
    expect(token).toBeTruthy();
    const res = await app.inject({ method: "POST", url: "/auth/verify-email", payload: { token } });
    expect(res.statusCode).toBe(204);
    const user = await db.user.findUnique({ where: { email: body.email } });
    expect(user?.emailVerified).toBe(true);
  });

  it("login com senha correta → 200; errada → 401", async () => {
    await app.inject({ method: "POST", url: "/auth/register", payload: body });
    const ok = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: body.email, password: body.password },
    });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: body.email, password: "errada" },
    });
    expect(bad.statusCode).toBe(401);
  });
});
