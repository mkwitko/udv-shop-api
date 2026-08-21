import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

const CONTACT = { name: "Maria Silva", phone: "(11) 98888-7777" };

async function seedStore() {
  return db.store.create({
    data: {
      slug: "nucleo-a",
      name: "Núcleo A",
      status: "active",
      stripeAccountId: "acct_1",
      stripeTransfersEnabled: true,
      wooviPixKey: "pix@nucleo.org",
      applicationFeeBps: 500,
    },
  });
}

function guestDonation(app: FastifyInstance, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/donations",
    payload: {
      storeSlug: "nucleo-a",
      provider: "woovi",
      type: "one_time",
      amountCents: 2500,
      contact: CONTACT,
      ...payload,
    },
  });
}

describe("doação sem conta", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("doa avulso por Pix e devolve o token do recibo", async () => {
    await seedStore();
    const res = await guestDonation(app);
    expect(res.statusCode).toBe(201);
    expect(res.json().receiptToken).toEqual(expect.any(String));
    const user = await db.user.findUniqueOrThrow({ where: { phone: "5511988887777" } });
    expect(user.passwordHash).toBeNull();
    expect(user.email).toBeNull();
    const donation = await db.donation.findUniqueOrThrow({ where: { id: res.json().donation.id } });
    expect(donation.userId).toBe(user.id);
  });

  it("mensal sem sessão exige login", async () => {
    await seedStore();
    const res = await guestDonation(app, {
      provider: "stripe",
      type: "monthly",
      contact: { ...CONTACT, email: "maria@example.org" },
    });
    expect(res.statusCode).toBe(401);
    // nem a conta leve nasce: a recusa vem antes de qualquer escrita
    expect(await db.user.count()).toBe(0);
    expect(await db.donation.count()).toBe(0);
  });

  it("recibo mostra status e números da sorte, sem o doador", async () => {
    await seedStore();
    const created = await guestDonation(app);
    const { donation, receiptToken } = created.json();
    const res = await app.inject({
      method: "GET",
      url: `/donations/${donation.id}/receipt?token=${receiptToken}`,
    });
    expect(res.statusCode).toBe(200);
    const receipt = res.json();
    expect(receipt.status).toBe("pending_payment");
    expect(receipt.amountCents).toBe(2500);
    expect(receipt.raffleNumbers).toEqual([]);
    expect(receipt.campaign).toBeNull();
    expect(JSON.stringify(receipt)).not.toContain("Maria");
    expect(JSON.stringify(receipt)).not.toContain("98888");
  });

  it("recibo devolve a cobrança Pix para a tela renascer depois de um F5", async () => {
    await seedStore();
    const created = await guestDonation(app);
    const { donation, receiptToken, payment } = created.json();
    const res = await app.inject({
      method: "GET",
      url: `/donations/${donation.id}/receipt?token=${receiptToken}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pix).toEqual({
      brCode: payment.brCode,
      qrCodeImageUrl: payment.qrCodeImageUrl,
      expiresAt: expect.any(String),
    });
  });

  it("token errado é 404", async () => {
    await seedStore();
    const created = await guestDonation(app);
    const res = await app.inject({
      method: "GET",
      url: `/donations/${created.json().donation.id}/receipt?token=00000000-0000-4000-8000-000000000000`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("contato de quem já tem conta anexa a doação àquela conta", async () => {
    await seedStore();
    const membro = await db.user.create({
      data: { name: "Membro", email: "membro@example.org", passwordHash: "hash" },
    });
    const res = await guestDonation(app, {
      contact: { ...CONTACT, email: "membro@example.org" },
    });
    expect(res.statusCode).toBe(201);
    const donation = await db.donation.findUniqueOrThrow({ where: { id: res.json().donation.id } });
    expect(donation.userId).toBe(membro.id);
    // o formulário do convidado não reescreve o cadastro de quem tem senha
    expect((await db.user.findUniqueOrThrow({ where: { id: membro.id } })).phone).toBeNull();
    expect(await db.user.count()).toBe(1);
  });

  it("doação de quem está logado não ganha token", async () => {
    await seedStore();
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Membro", email: "membro@example.org", password: "senha-forte-123" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/donations",
      headers: { authorization: `Bearer ${registered.json().accessToken}` },
      payload: {
        storeSlug: "nucleo-a",
        provider: "woovi",
        type: "one_time",
        amountCents: 2500,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().receiptToken).toBeNull();
  });
});
