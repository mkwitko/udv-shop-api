import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { logger } from "../../src/infra/observability/logger.js";
import { relayOutbox } from "../../src/workers/outbox-relay.js";
import { enqueueWooviWithdraw } from "../../src/workers/payment-routing.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways, type FakeGateways } from "../mocks/gateways.fake.js";

const PIX = "nucleo@example.org";

async function ownerToken(app: FastifyInstance, email: string, storeId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Dono", email, password: "senha-forte-123" },
  });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  await db.userStoreRole.create({ data: { userId: user.id, storeId, role: "owner" } });
  const cookie = res.cookies.find((c) => c.name === "udv_rt")?.value ?? "";
  const refreshed = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    cookies: { udv_rt: cookie },
  });
  return refreshed.json().accessToken as string;
}

function seedStore() {
  return db.store.create({
    data: {
      slug: "nx",
      name: "Núcleo X",
      status: "active",
      wooviPixKey: PIX,
      wooviSubaccountId: PIX,
    },
  });
}

describe("saldo e saque da subconta Woovi", () => {
  let app: FastifyInstance;
  let gateways: FakeGateways;

  beforeAll(async () => {
    gateways = buildFakeGateways();
    app = await buildApp({ gateways });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    gateways.wooviWithdrawals.length = 0;
    gateways.wooviBalances.clear();
    gateways.wooviWithdrawBlocked.clear();
  });

  it("mostra o saldo que a Woovi ainda não entregou", async () => {
    const store = await seedStore();
    gateways.wooviBalances.set(PIX, 45_00);
    const token = await ownerToken(app, "o1@example.org", store.id);

    const res = await app.inject({
      method: "GET",
      url: "/stores/nx/connect/woovi/balance",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, balanceCents: 4500, withdrawBlocked: false });
  });

  it("loja sem Pix configurado não vira erro — só não tem saldo", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "N", status: "active" } });
    const token = await ownerToken(app, "o2@example.org", store.id);

    const res = await app.inject({
      method: "GET",
      url: "/stores/nx/connect/woovi/balance",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().available).toBe(false);
  });

  it("saque manual leva o saldo e informa quanto saiu", async () => {
    const store = await seedStore();
    gateways.wooviBalances.set(PIX, 120_00);
    const token = await ownerToken(app, "o3@example.org", store.id);

    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/connect/woovi/withdraw",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    // o valor vem do saldo lido ANTES do saque: depois a Woovi devolveria zero
    expect(res.json()).toEqual({ status: "requested", balanceCents: 12000 });
    expect(gateways.wooviWithdrawals).toEqual([PIX]);
    expect(gateways.wooviBalances.get(PIX)).toBe(0);
  });

  it("subconta zerada responde `empty`, não erro", async () => {
    const store = await seedStore();
    gateways.wooviBalances.set(PIX, 0);
    const token = await ownerToken(app, "o4@example.org", store.id);

    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/connect/woovi/withdraw",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("empty");
  });

  it("saque bloqueado pela Woovi é dito na cara, não escondido em 200 vazio", async () => {
    const store = await seedStore();
    gateways.wooviBalances.set(PIX, 90_00);
    gateways.wooviWithdrawBlocked.add(PIX);
    const token = await ownerToken(app, "o5@example.org", store.id);

    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/connect/woovi/withdraw",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.json().status).toBe("blocked");
    // dinheiro continua na subconta: o núcleo precisa saber que não recebeu
    expect(gateways.wooviBalances.get(PIX)).toBe(9000);
  });

  it("staff não saca: movimentar dinheiro é do owner", async () => {
    const store = await seedStore();
    gateways.wooviBalances.set(PIX, 50_00);
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "St", email: "st@example.org", password: "senha-forte-123" },
    });
    const user = await db.user.findUniqueOrThrow({ where: { email: "st@example.org" } });
    await db.userStoreRole.create({ data: { userId: user.id, storeId: store.id, role: "staff" } });
    const cookie = reg.cookies.find((c) => c.name === "udv_rt")?.value ?? "";
    const refreshed = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { udv_rt: cookie },
    });

    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/connect/woovi/withdraw",
      headers: { authorization: `Bearer ${refreshed.json().accessToken}` },
    });

    expect(res.statusCode).toBe(403);
    expect(gateways.wooviWithdrawals).toHaveLength(0);
  });

  it("Pix confirmado enfileira o saque e o outbox executa — sem isso o dinheiro fica retido", async () => {
    const store = await seedStore();
    const user = await db.user.create({
      data: { email: "cliente@example.org", name: "C", emailVerified: true },
    });
    const donation = await db.donation.create({
      data: { storeId: store.id, userId: user.id, amountCents: 3000, status: "pending_payment" },
    });
    const payment = await db.payment.create({
      data: {
        donationId: donation.id,
        provider: "woovi",
        amountCents: 3000,
        applicationFeeCents: 0,
        status: "pending",
      },
    });
    gateways.wooviBalances.set(PIX, 3000);

    await enqueueWooviWithdraw({ db, paymentId: payment.id });
    const enfileirado = await db.outboxEvent.findFirst({ where: { type: "woovi.withdraw" } });
    expect(enfileirado).not.toBeNull();

    await relayOutbox({ db, email: gateways.email, woovi: gateways.woovi, log: logger });

    expect(gateways.wooviWithdrawals).toEqual([PIX]);
    const depois = await db.outboxEvent.findFirstOrThrow({ where: { type: "woovi.withdraw" } });
    expect(depois.status).toBe("processed");
  });

  it("saque bloqueado não fica em retry infinito no outbox", async () => {
    const store = await seedStore();
    gateways.wooviBalances.set(PIX, 7000);
    gateways.wooviWithdrawBlocked.add(PIX);
    await db.outboxEvent.create({
      data: { type: "woovi.withdraw", payload: { storeId: store.id, pixKey: PIX } },
    });

    await relayOutbox({ db, email: gateways.email, woovi: gateways.woovi, log: logger });

    // "blocked" é decisão da Woovi, não falha nossa: o evento fecha e fica no log
    const row = await db.outboxEvent.findFirstOrThrow({ where: { type: "woovi.withdraw" } });
    expect(row.status).toBe("processed");
    expect(row.attempts).toBe(0);
  });
});

describe("troca de chave Pix", () => {
  let app: FastifyInstance;
  let gateways: FakeGateways;

  beforeAll(async () => {
    gateways = buildFakeGateways();
    app = await buildApp({ gateways });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    gateways.wooviSubAccounts.length = 0;
    gateways.wooviWithdrawals.length = 0;
    gateways.wooviBalances.clear();
    gateways.wooviWithdrawBlocked.clear();
  });

  async function salvarChave(token: string, pixKey: string) {
    return app.inject({
      method: "PUT",
      url: "/stores/nx/connect/woovi",
      headers: { authorization: `Bearer ${token}` },
      payload: { pixKey },
    });
  }

  it("salvar a mesma chave não cria subconta nova", async () => {
    const store = await seedStore();
    const token = await ownerToken(app, "t1@example.org", store.id);

    const res = await salvarChave(token, PIX);

    expect(res.statusCode).toBe(200);
    expect(gateways.wooviSubAccounts).toHaveLength(0);
  });

  it("chave nova cria uma subconta só", async () => {
    const store = await seedStore();
    const token = await ownerToken(app, "t2@example.org", store.id);

    await salvarChave(token, "outra@example.org");

    expect(gateways.wooviSubAccounts).toEqual([{ name: "Núcleo X", pixKey: "outra@example.org" }]);
    const persisted = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(persisted.wooviPixKey).toBe("outra@example.org");
  });

  it("saldo na subconta antiga é sacado ANTES da troca — senão fica invisível", async () => {
    const store = await seedStore();
    gateways.wooviBalances.set(PIX, 8000);
    const token = await ownerToken(app, "t3@example.org", store.id);

    const res = await salvarChave(token, "nova@example.org");

    expect(res.statusCode).toBe(200);
    // sacou para a chave ANTIGA: é para lá que aquele dinheiro estava destinado
    expect(gateways.wooviWithdrawals).toEqual([PIX]);
    expect(gateways.wooviBalances.get(PIX)).toBe(0);
  });

  it("saque bloqueado barra a troca em vez de esconder o dinheiro", async () => {
    const store = await seedStore();
    gateways.wooviBalances.set(PIX, 15_000);
    gateways.wooviWithdrawBlocked.add(PIX);
    const token = await ownerToken(app, "t4@example.org", store.id);

    const res = await salvarChave(token, "nova@example.org");

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe("woovi_withdraw_blocked");
    // chave antiga preservada: o saldo continua visível na tela do núcleo
    const persisted = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(persisted.wooviPixKey).toBe(PIX);
    expect(gateways.wooviSubAccounts).toHaveLength(0);
  });

  it("subconta antiga vazia troca direto, sem saque", async () => {
    const store = await seedStore();
    gateways.wooviBalances.set(PIX, 0);
    const token = await ownerToken(app, "t5@example.org", store.id);

    await salvarChave(token, "nova@example.org");

    expect(gateways.wooviWithdrawals).toHaveLength(0);
    expect(gateways.wooviSubAccounts).toHaveLength(1);
  });
});
