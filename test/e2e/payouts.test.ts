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
  return login.json().accessToken as string;
}

async function seedStore() {
  return db.store.create({
    data: {
      slug: "nucleo-a",
      name: "Núcleo A",
      status: "active",
      stripeAccountId: "acct_1",
      wooviPixKey: "pix@nucleo.org",
      applicationFeeBps: 500,
    },
  });
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("repasses para parceiros", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("cadastra parceiro, lista, e recusa nome repetido", async () => {
    const store = await seedStore();
    const token = await tokenWithRole(app, "adm@example.org", store.id, "admin");

    const created = await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/suppliers",
      headers: auth(token),
      payload: { name: "Dona Ana", phone: "48999995678", pixKey: "ana@example.org" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "Dona Ana", active: true });

    const dup = await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/suppliers",
      headers: auth(token),
      payload: { name: "Dona Ana" },
    });
    expect(dup.statusCode).toBe(409);

    const list = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/suppliers",
      headers: auth(token),
    });
    expect(list.json().items).toHaveLength(1);
  });

  it("staff não enxerga repasses: é acordo comercial da loja", async () => {
    const store = await seedStore();
    const staff = await tokenWithRole(app, "st@example.org", store.id, "staff");
    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/payouts",
      headers: auth(staff),
    });
    expect(res.statusCode).toBe(403);
  });

  it("recusa repasse maior do que o preço menos a taxa", async () => {
    const store = await seedStore();
    const token = await tokenWithRole(app, "adm2@example.org", store.id, "admin");
    const supplier = await db.supplier.create({ data: { storeId: store.id, name: "Ana" } });

    // preço 100,00 com taxa de 5% deixa 95,00 para dividir
    const res = await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/products",
      headers: auth(token),
      payload: {
        name: "Cesto",
        slug: "cesto",
        priceCents: 10000,
        stock: 3,
        supplierId: supplier.id,
        payoutKind: "fixed_cents",
        payoutValue: 9600,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("payout_exceeds_price");
  });

  it("acordo pela metade não é salvo", async () => {
    const store = await seedStore();
    const token = await tokenWithRole(app, "adm3@example.org", store.id, "admin");
    const res = await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/products",
      headers: auth(token),
      payload: {
        name: "Cesto",
        slug: "cesto",
        priceCents: 10000,
        stock: 3,
        payoutKind: "percent_bps",
        payoutValue: 5000,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("payout_incomplete");
  });

  it("venda paga gera saldo, registrar pagamento zera, reembolso vira crédito", async () => {
    const store = await seedStore();
    const admin = await tokenWithRole(app, "adm4@example.org", store.id, "admin");
    const supplier = await db.supplier.create({
      data: { storeId: store.id, name: "Ana", pixKey: "ana@example.org" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/products",
      headers: auth(admin),
      payload: {
        name: "Cesto",
        slug: "cesto",
        priceCents: 10000,
        stock: 5,
        supplierId: supplier.id,
        payoutKind: "percent_bps",
        payoutValue: 6000,
      },
    });
    expect(created.json().payout).toMatchObject({
      supplierName: "Ana",
      kind: "percent_bps",
      value: 6000,
      unitCents: 6000,
    });

    const buyer = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Cliente", email: "cli@example.org", password: "senha-forte-123" },
    });
    const checkout = await app.inject({
      method: "POST",
      url: "/orders",
      headers: auth(buyer.json().accessToken),
      payload: {
        storeSlug: "nucleo-a",
        provider: "stripe",
        items: [{ productSlug: "cesto", qty: 2 }],
        contactPhone: "11999990000",
      },
    });
    expect(checkout.statusCode).toBe(201);
    const orderId = checkout.json().order.id as string;

    // pedido reservado ainda não gerou repasse: pode expirar
    const pendente = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/payouts",
      headers: auth(admin),
    });
    expect(pendente.json().totals.balanceCents).toBe(0);

    await db.order.update({ where: { id: orderId }, data: { status: "paid" } });

    const comSaldo = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/payouts",
      headers: auth(admin),
    });
    // 60% de R$ 100,00 em duas unidades
    expect(comSaldo.json().totals).toEqual({
      earnedCents: 12000,
      settledCents: 0,
      balanceCents: 12000,
    });

    const settled = await app.inject({
      method: "POST",
      url: `/stores/nucleo-a/payouts/${supplier.id}/settlements`,
      headers: auth(admin),
      payload: { amountCents: 12000, note: "Pix de sexta" },
    });
    expect(settled.statusCode).toBe(201);
    expect(settled.json().balanceCents).toBe(0);

    const detalhe = await app.inject({
      method: "GET",
      url: `/stores/nucleo-a/payouts/${supplier.id}`,
      headers: auth(admin),
    });
    const detail = detalhe.json();
    expect(detail.sales).toHaveLength(1);
    expect(detail.sales[0]).toMatchObject({ productName: "Cesto", qty: 2, payoutCents: 12000 });
    expect(detail.settlements[0]).toMatchObject({ amountCents: 12000, note: "Pix de sexta" });

    // reembolso derruba a receita e o saldo fica negativo: crédito da loja
    await db.order.update({ where: { id: orderId }, data: { status: "refunded" } });
    const depois = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/payouts",
      headers: auth(admin),
    });
    expect(depois.json().totals.balanceCents).toBe(-12000);
  });

  it("acordo de repasse não vaza na vitrine pública", async () => {
    const store = await seedStore();
    const supplier = await db.supplier.create({ data: { storeId: store.id, name: "Ana" } });
    await db.product.create({
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

    const publico = await app.inject({ method: "GET", url: "/stores/nucleo-a/products/cesto" });
    expect(publico.statusCode).toBe(200);
    expect(publico.json().payout).toBeNull();
    expect(publico.payload).not.toContain("Ana");

    const admin = await tokenWithRole(app, "adm5@example.org", store.id, "admin");
    const interno = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/products/cesto",
      headers: auth(admin),
    });
    expect(interno.json().payout).toMatchObject({ supplierName: "Ana", unitCents: 6000 });
  });

  it("repasse congelado na venda não muda quando o acordo muda depois", async () => {
    const store = await seedStore();
    const admin = await tokenWithRole(app, "adm6@example.org", store.id, "admin");
    const supplier = await db.supplier.create({ data: { storeId: store.id, name: "Ana" } });
    await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/products",
      headers: auth(admin),
      payload: {
        name: "Cesto",
        slug: "cesto",
        priceCents: 10000,
        stock: 5,
        supplierId: supplier.id,
        payoutKind: "fixed_cents",
        payoutValue: 4000,
      },
    });
    const buyer = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Cliente", email: "cli2@example.org", password: "senha-forte-123" },
    });
    const checkout = await app.inject({
      method: "POST",
      url: "/orders",
      headers: auth(buyer.json().accessToken),
      payload: {
        storeSlug: "nucleo-a",
        provider: "stripe",
        items: [{ productSlug: "cesto", qty: 1 }],
        contactPhone: "11999990000",
      },
    });
    await db.order.update({
      where: { id: checkout.json().order.id },
      data: { status: "delivered" },
    });

    await app.inject({
      method: "PATCH",
      url: "/stores/nucleo-a/products/cesto",
      headers: auth(admin),
      payload: { payoutValue: 1000, payoutKind: "fixed_cents", supplierId: supplier.id },
    });

    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/payouts",
      headers: auth(admin),
    });
    expect(res.json().totals.earnedCents).toBe(4000);
  });

  it("parceiro de outra loja não serve para combinar repasse", async () => {
    const store = await seedStore();
    const other = await db.store.create({
      data: { slug: "nucleo-b", name: "Núcleo B", status: "active" },
    });
    const outsider = await db.supplier.create({ data: { storeId: other.id, name: "Alheia" } });
    const admin = await tokenWithRole(app, "adm7@example.org", store.id, "admin");

    const res = await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/products",
      headers: auth(admin),
      payload: {
        name: "Cesto",
        slug: "cesto",
        priceCents: 10000,
        stock: 5,
        supplierId: outsider.id,
        payoutKind: "fixed_cents",
        payoutValue: 1000,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("supplier_not_found");
  });
});
