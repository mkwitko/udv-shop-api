import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

const CONTACT = { name: "Maria Silva", phone: "(11) 98888-7777" };

/** Turnstile ligado, aceitando só o token "bom". */
function turnstileOn() {
  return {
    enabled: true as const,
    verify: async ({ token }: { token: string }) => token === "bom",
  };
}

async function seedStore() {
  const store = await db.store.create({
    data: { slug: "nucleo-a", name: "Núcleo A", status: "active" },
  });
  await db.product.create({
    data: {
      storeId: store.id,
      slug: "cha-especial",
      name: "Chá especial",
      priceCents: 5000,
      availability: "on_demand",
    },
  });
  return { store };
}

/**
 * O desafio existe para conter criação de conta leve em massa. Ele só entra quando a plataforma
 * tem segredo configurado, e nunca atrapalha quem já tem sessão.
 */
describe("desafio anti-abuso nas rotas sem conta", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways({ turnstile: turnstileOn() }) });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  const payload = { storeSlug: "nucleo-a", productSlug: "cha-especial", contact: CONTACT };

  it("sem o desafio, a escrita de convidado é recusada", async () => {
    await seedStore();
    const res = await app.inject({ method: "POST", url: "/interests", payload });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain("captcha_required");
    expect(await db.user.count()).toBe(0);
  });

  it("desafio inválido é recusado", async () => {
    await seedStore();
    const res = await app.inject({
      method: "POST",
      url: "/interests",
      payload: { ...payload, captchaToken: "falso" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain("captcha_failed");
    expect(await db.user.count()).toBe(0);
  });

  it("desafio válido passa", async () => {
    await seedStore();
    const res = await app.inject({
      method: "POST",
      url: "/interests",
      payload: { ...payload, captchaToken: "bom" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("quem tem sessão não precisa de desafio", async () => {
    await seedStore();
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Membro", email: "membro@example.org", password: "senha-forte-123" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/interests",
      headers: { authorization: `Bearer ${registered.json().accessToken}` },
      payload: { storeSlug: "nucleo-a", productSlug: "cha-especial" },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("desafio desligado deixa tudo passar", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("sem segredo configurado, convidado não precisa de desafio", async () => {
    await seedStore();
    const res = await app.inject({
      method: "POST",
      url: "/interests",
      payload: { storeSlug: "nucleo-a", productSlug: "cha-especial", contact: CONTACT },
    });
    expect(res.statusCode).toBe(201);
  });
});
