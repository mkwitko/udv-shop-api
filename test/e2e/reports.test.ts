import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

async function tokenWithRole(
  app: FastifyInstance,
  email: string,
  storeId: string,
  role: "owner" | "admin" | "staff",
) {
  await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Pessoa", email, password: "senha-forte-123" },
  });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  await db.userStoreRole.create({ data: { userId: user.id, storeId, role } });
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password: "senha-forte-123" },
  });
  return { token: login.json().accessToken as string, userId: user.id };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Uma venda paga de 100,00 com 5% de taxa e 60,00 de repasse para a parceira. */
async function seedMovement() {
  const store = await db.store.create({
    data: { slug: "nucleo-a", name: "Núcleo A", status: "active", applicationFeeBps: 500 },
  });
  const supplier = await db.supplier.create({ data: { storeId: store.id, name: "Ana" } });
  const product = await db.product.create({
    data: {
      storeId: store.id,
      slug: "cesto",
      name: "Cesto",
      priceCents: 10000,
      stock: 5,
      supplierId: supplier.id,
      payoutKind: "percent_bps",
      payoutValue: 6000,
    },
  });
  const customer = await db.user.create({
    data: { name: "Maria Silva", email: "maria@example.org", phone: "5548999995678" },
  });
  const order = await db.order.create({
    data: {
      storeId: store.id,
      userId: customer.id,
      status: "paid",
      totalCents: 10000,
      contactPhone: "11999990000",
      expiresAt: new Date(),
      items: {
        create: [
          {
            productId: product.id,
            name: product.name,
            priceCents: 10000,
            qty: 1,
            supplierId: supplier.id,
            payoutCents: 6000,
          },
        ],
      },
    },
  });
  await db.payment.create({
    data: {
      orderId: order.id,
      provider: "stripe",
      providerId: "pi_report",
      amountCents: 10000,
      applicationFeeCents: 500,
      status: "succeeded",
    },
  });
  await db.interest.create({
    data: { productId: product.id, userId: customer.id, qty: 2, status: "open" },
  });
  return { store, supplier, order, customer };
}

describe("extrato e exportação", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("extrato soma venda, taxa e repasse do mês", async () => {
    const { store } = await seedMovement();
    const { token } = await tokenWithRole(app, "adm@example.org", store.id, "admin");

    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/statement",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals).toMatchObject({
      salesCount: 1,
      salesGrossCents: 10000,
      donationsCount: 0,
      donationsGrossCents: 0,
      feeCents: 500,
      // taxa do provedor ainda não gravada neste pagamento do fixture
      providerFeeCents: 0,
      payoutCents: 6000,
      netCents: 3500,
    });
    expect(body.months).toHaveLength(1);
    expect(body.payoutsOpenCents).toBe(6000);
  });

  it("mostra a taxa do provedor separada da comissão e desconta as duas do líquido", async () => {
    const { store, order } = await seedMovement();
    // Cartão: R$ 4,39 de taxa do Stripe, e comissão zero como em toda loja hoje.
    await db.payment.update({
      where: { orderId: order.id },
      data: { applicationFeeCents: 0, providerFeeCents: 439 },
    });
    const { token } = await tokenWithRole(app, "adm-taxa@example.org", store.id, "admin");

    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/statement",
      headers: auth(token),
    });

    expect(res.statusCode).toBe(200);
    const { totals } = res.json();
    // A plataforma não cobra comissão, e o zero fica visível de propósito.
    expect(totals.feeCents).toBe(0);
    expect(totals.providerFeeCents).toBe(439);
    expect(totals.netCents).toBe(10000 - 439 - 6000);
  });

  it("conta pagamento antigo sem taxa registrada como zero, não como erro", async () => {
    const { store, order } = await seedMovement();
    // `null` é pagamento anterior ao ADR-029: a plataforma pagou a taxa, a loja não.
    await db.payment.update({
      where: { orderId: order.id },
      data: { applicationFeeCents: 0, providerFeeCents: null },
    });
    const { token } = await tokenWithRole(app, "adm-nulo@example.org", store.id, "admin");

    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/statement",
      headers: auth(token),
    });

    expect(res.json().totals.providerFeeCents).toBe(0);
    expect(res.json().totals.netCents).toBe(10000 - 6000);
  });

  it("repasse já pago sai do saldo em aberto, mas continua no extrato do mês", async () => {
    const { store, supplier } = await seedMovement();
    const { token, userId } = await tokenWithRole(app, "adm2@example.org", store.id, "admin");
    await db.supplierSettlement.create({
      data: {
        storeId: store.id,
        supplierId: supplier.id,
        amountCents: 6000,
        paidAt: new Date(),
        createdById: userId,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/statement",
      headers: auth(token),
    });
    expect(res.json().payoutsOpenCents).toBe(0);
    expect(res.json().totals.payoutCents).toBe(6000);
  });

  it("pedido reembolsado não entra no extrato", async () => {
    const { store, order } = await seedMovement();
    const { token } = await tokenWithRole(app, "adm3@example.org", store.id, "admin");
    await db.order.update({ where: { id: order.id }, data: { status: "refunded" } });
    await db.payment.update({ where: { orderId: order.id }, data: { status: "refunded" } });

    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/statement",
      headers: auth(token),
    });
    expect(res.json().totals).toMatchObject({ salesGrossCents: 0, feeCents: 0, netCents: 0 });
  });

  it("staff não vê extrato nem exportação", async () => {
    const { store } = await seedMovement();
    const { token } = await tokenWithRole(app, "st@example.org", store.id, "staff");
    for (const url of [
      "/stores/nucleo-a/statement",
      "/stores/nucleo-a/orders.csv",
      "/stores/nucleo-a/interests.csv",
    ]) {
      const res = await app.inject({ method: "GET", url, headers: auth(token) });
      expect(res.statusCode).toBe(403);
    }
  });

  it("CSV de pedidos vem como arquivo, com ponto e vírgula e valor em vírgula", async () => {
    const { store } = await seedMovement();
    const { token } = await tokenWithRole(app, "adm4@example.org", store.id, "admin");

    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/orders.csv",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("pedidos-nucleo-a.csv");
    const lines = res.payload.trim().split("\r\n");
    expect(lines[0]).toContain("Data;Pedido;Situação;Cliente");
    expect(lines[1]).toContain("Maria Silva");
    expect(lines[1]).toContain("1x Cesto");
    expect(lines[1]?.endsWith("100,00")).toBe(true);
  });

  it("CSV de encomendas mascara o telefone, como a tela", async () => {
    const { store } = await seedMovement();
    const { token } = await tokenWithRole(app, "adm5@example.org", store.id, "admin");

    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/interests.csv",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain("(48) ****-5678");
    expect(res.payload).not.toContain("999995678");
    expect(res.payload).toContain("esperando");
  });
});
