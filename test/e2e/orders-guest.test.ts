import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

const CONTACT = { name: "Maria Silva", phone: "(11) 98888-7777" };

async function seedStore() {
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
    },
  });
  const product = await db.product.create({
    data: { storeId: store.id, slug: "mel", name: "Mel", priceCents: 2500, stock: 10 },
  });
  return { store, product };
}

function guestCheckout(app: FastifyInstance, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/orders",
    payload: {
      storeSlug: "nucleo-a",
      provider: "woovi",
      items: [{ productSlug: "mel", qty: 1 }],
      contact: CONTACT,
      ...payload,
    },
  });
}

describe("checkout sem conta", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("cria pedido e devolve o token do recibo", async () => {
    await seedStore();
    const res = await guestCheckout(app);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.receiptToken).toEqual(expect.any(String));
    const order = await db.order.findUniqueOrThrow({ where: { id: body.order.id } });
    // o telefone do contato virou o telefone de entrega
    expect(order.contactPhone).toBe("(11) 98888-7777");
    const user = await db.user.findUniqueOrThrow({ where: { phone: "5511988887777" } });
    expect(user.passwordHash).toBeNull();
    expect(order.userId).toBe(user.id);
  });

  it("recibo público mostra o status sem expor a pessoa", async () => {
    await seedStore();
    const created = await guestCheckout(app, { items: [{ productSlug: "mel", qty: 2 }] });
    const { order, receiptToken } = created.json();
    const res = await app.inject({
      method: "GET",
      url: `/orders/${order.id}/receipt?token=${receiptToken}`,
    });
    expect(res.statusCode).toBe(200);
    const receipt = res.json();
    expect(receipt.status).toBe("pending_payment");
    expect(receipt.items[0].qty).toBe(2);
    expect(receipt.store.slug).toBe("nucleo-a");
    expect(JSON.stringify(receipt)).not.toContain("Maria");
    expect(JSON.stringify(receipt)).not.toContain("98888");
  });

  // O Pix fica minutos na tela esperando. Se o recibo não devolver a cobrança, um F5 deixa a
  // pessoa com um pedido pendente e nenhum jeito de pagá-lo.
  it("recibo devolve a cobrança Pix para a tela renascer depois de um F5", async () => {
    await seedStore();
    const created = await guestCheckout(app);
    const { order, receiptToken, payment } = created.json();
    const res = await app.inject({
      method: "GET",
      url: `/orders/${order.id}/receipt?token=${receiptToken}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pix).toEqual({
      brCode: payment.brCode,
      qrCodeImageUrl: payment.qrCodeImageUrl,
      expiresAt: expect.any(String),
    });
  });

  it("recibo de pedido no cartão não tem Pix", async () => {
    await seedStore();
    const created = await guestCheckout(app, { provider: "stripe" });
    const { order, receiptToken } = created.json();
    const res = await app.inject({
      method: "GET",
      url: `/orders/${order.id}/receipt?token=${receiptToken}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pix).toBeNull();
  });

  it("token errado é 404", async () => {
    await seedStore();
    const created = await guestCheckout(app);
    const res = await app.inject({
      method: "GET",
      url: `/orders/${created.json().order.id}/receipt?token=00000000-0000-4000-8000-000000000000`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("pedido de quem está logado não ganha token", async () => {
    await seedStore();
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Membro", email: "membro@example.org", password: "senha-forte-123" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${registered.json().accessToken}` },
      payload: {
        storeSlug: "nucleo-a",
        provider: "woovi",
        items: [{ productSlug: "mel", qty: 1 }],
        contactPhone: "(11) 97777-6666",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().receiptToken).toBeNull();
    // e sem token não há recibo público para esse pedido
    const receipt = await app.inject({
      method: "GET",
      url: `/orders/${res.json().order.id}/receipt?token=00000000-0000-4000-8000-000000000000`,
    });
    expect(receipt.statusCode).toBe(404);
  });

  it("sem contato e sem telefone exige login", async () => {
    await seedStore();
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        storeSlug: "nucleo-a",
        provider: "woovi",
        items: [{ productSlug: "mel", qty: 1 }],
      },
    });
    expect(res.statusCode).toBe(401);
  });
});
