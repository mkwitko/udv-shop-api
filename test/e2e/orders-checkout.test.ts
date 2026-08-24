import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways, type FakeGateways } from "../mocks/gateways.fake.js";

async function customerToken(app: FastifyInstance, email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Cliente", email, password: "senha-forte-123" },
  });
  return res.json().accessToken as string;
}

async function seedStore(overrides: Record<string, unknown> = {}) {
  const store = await db.store.create({
    data: {
      slug: "nucleo-a",
      name: "Núcleo A",
      status: "active",
      stripeAccountId: "acct_1",
      stripeTransfersEnabled: true,
      wooviPixKey: "pix@nucleo.org",
      wooviPixKeyStatus: "verified" as const,
      applicationFeeBps: 500,
      ...overrides,
    },
  });
  const product = await db.product.create({
    data: { storeId: store.id, slug: "mel", name: "Mel", priceCents: 2500, stock: 10 },
  });
  return { store, product };
}

function checkout(app: FastifyInstance, token: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/orders",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      storeSlug: "nucleo-a",
      provider: "stripe",
      items: [{ productSlug: "mel", qty: 2 }],
      contactPhone: "11999990000",
      ...payload,
    },
  });
}

describe("POST /orders", () => {
  let app: FastifyInstance;
  let gateways: FakeGateways;
  beforeAll(async () => {
    gateways = buildFakeGateways();
    app = await buildApp({ gateways });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("stripe: cria pedido pending_payment, reserva estoque, retorna clientSecret", async () => {
    const { product } = await seedStore();
    const token = await customerToken(app, "c1@example.org");
    const res = await checkout(app, token, {});
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.order.status).toBe("pending_payment");
    expect(json.order.totalCents).toBe(5000);
    expect(json.payment.provider).toBe("stripe");
    expect(json.payment.clientSecret).toBe("cs_fake");
    const fresh = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(fresh.stock).toBe(8);
    const intent = gateways.stripeIntents.at(-1);
    expect(intent?.amountCents).toBe(5000);
    expect(intent?.applicationFeeCents).toBe(250);
    expect(intent?.destinationAccountId).toBe("acct_1");
    const payment = await db.payment.findFirstOrThrow();
    expect(payment.providerId).toMatch(/^pi_fake_/);
  });

  it("woovi: retorna brCode e faz split de total - fee para a subconta", async () => {
    await seedStore();
    const token = await customerToken(app, "c2@example.org");
    const res = await checkout(app, token, { provider: "woovi" });
    expect(res.statusCode).toBe(201);
    expect(res.json().payment.brCode).toBe("000201fake");
    const charge = gateways.wooviCharges.at(-1);
    expect(charge?.amountCents).toBe(5000);
    expect(charge?.splitValueCents).toBe(4750);
    expect(charge?.splitPixKey).toBe("pix@nucleo.org");
    const payment = await db.payment.findFirstOrThrow();
    expect(charge?.correlationID).toBe(payment.id);
  });

  // A Woovi devolve 400 quando o split iguala o valor da cobrança, e loja sem comissão
  // (o padrão hoje: a plataforma vive de mensalidade) cairia exatamente nesse caso.
  it("woovi com loja sem comissão: retém 1 centavo em vez de tentar split de 100%", async () => {
    await seedStore({ applicationFeeBps: 0 });
    const token = await customerToken(app, "c-fee0@example.org");
    const res = await checkout(app, token, { provider: "woovi" });
    expect(res.statusCode).toBe(201);
    const charge = gateways.wooviCharges.at(-1);
    expect(charge?.amountCents).toBe(5000);
    expect(charge?.splitValueCents).toBe(4999);
    const payment = await db.payment.findFirstOrThrow();
    expect(payment.applicationFeeCents).toBe(1);
  });

  it("estoque insuficiente → 409 e nada persiste", async () => {
    const { product } = await seedStore();
    const token = await customerToken(app, "c3@example.org");
    const res = await checkout(app, token, { items: [{ productSlug: "mel", qty: 11 }] });
    expect(res.statusCode).toBe(409);
    expect(await db.order.count()).toBe(0);
    const fresh = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(fresh.stock).toBe(10);
  });

  it("produto on_demand → 400 product_not_orderable", async () => {
    const { store } = await seedStore();
    await db.product.create({
      data: {
        storeId: store.id,
        slug: "capa",
        name: "Capa",
        priceCents: 900,
        availability: "on_demand",
      },
    });
    const token = await customerToken(app, "c4@example.org");
    const res = await checkout(app, token, { items: [{ productSlug: "capa", qty: 1 }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("product_not_orderable");
  });

  it("loja sem provider configurado → 400 payments_not_configured", async () => {
    await seedStore({ stripeAccountId: null });
    const token = await customerToken(app, "c5@example.org");
    const res = await checkout(app, token, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("payments_not_configured");
  });

  it("loja conectada mas sem capability transfers → 400 payments_not_configured", async () => {
    // Onboarding começado não é onboarding concluído: sem `transfers` ativa a destination
    // charge seria recusada pelo Stripe com o pedido já criado no banco.
    await seedStore({ stripeTransfersEnabled: false });
    const token = await customerToken(app, "c5b@example.org");
    const res = await checkout(app, token, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("payments_not_configured");
  });

  it("loja não ativa → 404", async () => {
    await seedStore({ status: "pending" });
    const token = await customerToken(app, "c6@example.org");
    const res = await checkout(app, token, {});
    expect(res.statusCode).toBe(404);
  });

  it("gateway falhou → compensa estoque e 502", async () => {
    const failing = buildFakeGateways();
    failing.stripe.createPaymentIntent = async () => {
      throw new Error("boom");
    };
    const app2 = await buildApp({ gateways: failing });
    await app2.ready();
    const { product } = await seedStore();
    const token = await customerToken(app2, "c7@example.org");
    const res = await checkout(app2, token, {});
    expect(res.statusCode).toBe(502);
    const fresh = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(fresh.stock).toBe(10);
    const order = await db.order.findFirstOrThrow();
    expect(order.status).toBe("cancelled");
    await app2.close();
  });

  // A rota é pública desde o fluxo sem conta: corpo inválido é 400, e é a falta de identidade
  // (nem sessão nem `contact`) que dá 401. Ver orders-guest.test.ts.
  it("corpo inválido → 400", async () => {
    await seedStore();
    const res = await app.inject({ method: "POST", url: "/orders", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("sem token e sem contato → 401", async () => {
    await seedStore();
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        storeSlug: "nucleo-a",
        provider: "stripe",
        items: [{ productSlug: "mel", qty: 1 }],
        contactPhone: "11999990000",
      },
    });
    expect(res.statusCode).toBe(401);
  });
});
