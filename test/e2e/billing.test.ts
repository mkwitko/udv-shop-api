import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways, type FakeGateways } from "../mocks/gateways.fake.js";

const PERIOD_END = 1_800_000_000;

async function registerWithRole(
  app: FastifyInstance,
  email: string,
  storeId: string | null,
  role: "owner" | "admin" | "staff" | null,
) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Pessoa", email, password: "senha-forte-123" },
  });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  const cookie = res.cookies.find((c) => c.name === "udv_rt")?.value ?? "";
  if (storeId && role) {
    await db.userStoreRole.create({ data: { userId: user.id, storeId, role } });
  }
  const refreshed = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    cookies: { udv_rt: cookie },
  });
  return { token: refreshed.json().accessToken as string, user };
}

function seedStore() {
  return db.store.create({ data: { slug: "nx", name: "Núcleo X", status: "pending" } });
}

function stripeEvent(app: FastifyInstance, event: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: { "stripe-signature": "ok", "content-type": "application/json" },
    payload: JSON.stringify(event),
  });
}

function subscriptionEvent(
  app: FastifyInstance,
  input: {
    eventId: string;
    type: string;
    storeId?: string;
    status: string;
    account?: string;
    subscriptionId?: string;
  },
) {
  return stripeEvent(app, {
    id: input.eventId,
    type: input.type,
    ...(input.account ? { account: input.account } : {}),
    data: {
      object: {
        id: input.subscriptionId ?? "sub_saas_1",
        customer: "cus_1",
        status: input.status,
        cancel_at_period_end: false,
        ...(input.storeId ? { metadata: { storeId: input.storeId } } : {}),
        // Basil+: o período vive no item, não no topo da assinatura.
        items: { data: [{ current_period_end: PERIOD_END, price: { id: "price_test_saas" } }] },
      },
    },
  });
}

describe("billing — assinatura SaaS na conta da plataforma", () => {
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
    gateways.stripeSaasCheckouts.length = 0;
    gateways.stripePortalSessions.length = 0;
  });

  it("POST checkout devolve a url e manda o storeId na sessão", async () => {
    const store = await seedStore();
    const { token } = await registerWithRole(app, "b1@example.org", store.id, "owner");
    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/billing/checkout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().url).toContain("checkout.fake");
    expect(gateways.stripeSaasCheckouts).toHaveLength(1);
    expect(gateways.stripeSaasCheckouts[0]).toMatchObject({
      storeId: store.id,
      priceId: "price_test_saas",
      customerId: null,
      customerEmail: "b1@example.org",
    });
  });

  it("checkout.session.completed + assinatura ativa: loja pending vira active e GET billing reflete", async () => {
    const store = await seedStore();
    const { token } = await registerWithRole(app, "b2@example.org", store.id, "owner");

    await stripeEvent(app, {
      id: "evt_cs",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          mode: "subscription",
          customer: "cus_1",
          client_reference_id: store.id,
          metadata: { storeId: store.id },
        },
      },
    });
    await subscriptionEvent(app, {
      eventId: "evt_sub_created",
      type: "customer.subscription.created",
      storeId: store.id,
      status: "active",
    });

    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("active");
    const res = await app.inject({
      method: "GET",
      url: "/stores/nx/billing",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "active",
      currentPeriodEnd: new Date(PERIOD_END * 1000).toISOString(),
      cancelAtPeriodEnd: false,
    });
    // Nenhuma referência do provedor vaza na resposta.
    const body = JSON.stringify(res.json());
    expect(body).not.toContain("cus_1");
    expect(body).not.toContain("sub_saas_1");
  });

  it("customer.subscription.deleted da plataforma suspende a loja ativa", async () => {
    const store = await seedStore();
    await subscriptionEvent(app, {
      eventId: "evt_a",
      type: "customer.subscription.created",
      storeId: store.id,
      status: "active",
    });
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("active");

    await subscriptionEvent(app, {
      eventId: "evt_d",
      type: "customer.subscription.deleted",
      storeId: store.id,
      status: "active",
    });

    const suspended = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(suspended.status).toBe("suspended");
    expect(suspended.suspensionReason).toBe("billing");
    const subscription = await db.storeSubscription.findUniqueOrThrow({
      where: { storeId: store.id },
    });
    expect(subscription.status).toBe("canceled");
  });

  it("loja suspensa por cobrança volta ao ar quando a assinatura é retomada", async () => {
    const store = await seedStore();
    await subscriptionEvent(app, {
      eventId: "evt_r1",
      type: "customer.subscription.created",
      storeId: store.id,
      status: "active",
    });
    await subscriptionEvent(app, {
      eventId: "evt_r2",
      type: "customer.subscription.deleted",
      storeId: store.id,
      status: "active",
    });
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe(
      "suspended",
    );

    await subscriptionEvent(app, {
      eventId: "evt_r3",
      type: "customer.subscription.updated",
      storeId: store.id,
      status: "active",
    });

    const back = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(back.status).toBe("active");
    expect(back.suspensionReason).toBeNull();
  });

  it("past_due não tira a loja do ar", async () => {
    const store = await seedStore();
    await subscriptionEvent(app, {
      eventId: "evt_a2",
      type: "customer.subscription.created",
      storeId: store.id,
      status: "active",
    });
    await subscriptionEvent(app, {
      eventId: "evt_pd",
      type: "customer.subscription.updated",
      storeId: store.id,
      status: "past_due",
    });
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("active");
  });

  it("loja suspensa pela plataforma não é reativada por assinatura ativa", async () => {
    const store = await seedStore();
    await db.store.update({
      where: { id: store.id },
      data: { status: "suspended", suspensionReason: "platform" },
    });
    await subscriptionEvent(app, {
      eventId: "evt_sus",
      type: "customer.subscription.created",
      storeId: store.id,
      status: "active",
    });
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe(
      "suspended",
    );
  });

  it("customer.subscription.deleted vindo de conta conectada não toca a assinatura SaaS", async () => {
    const store = await seedStore();
    await subscriptionEvent(app, {
      eventId: "evt_saas_ok",
      type: "customer.subscription.created",
      storeId: store.id,
      status: "active",
    });

    // Mesmo id de assinatura, mas o evento nasceu na conta do núcleo: é cancelamento de
    // doação mensal, não da assinatura da plataforma.
    await subscriptionEvent(app, {
      eventId: "evt_connect_del",
      type: "customer.subscription.deleted",
      storeId: store.id,
      status: "active",
      account: "acct_do_nucleo",
    });

    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("active");
    const subscription = await db.storeSubscription.findUniqueOrThrow({
      where: { storeId: store.id },
    });
    expect(subscription.status).toBe("active");
  });

  it("checkout com assinatura já ativa → 409; portal sem assinatura → 409", async () => {
    const store = await seedStore();
    const { token } = await registerWithRole(app, "b3@example.org", store.id, "owner");

    const portalSemAssinatura = await app.inject({
      method: "POST",
      url: "/stores/nx/billing/portal",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(portalSemAssinatura.statusCode).toBe(409);
    expect(portalSemAssinatura.json().message).toBe("no_subscription");

    await subscriptionEvent(app, {
      eventId: "evt_dup",
      type: "customer.subscription.created",
      storeId: store.id,
      status: "active",
    });

    const checkout = await app.inject({
      method: "POST",
      url: "/stores/nx/billing/checkout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(checkout.statusCode).toBe(409);
    expect(checkout.json().message).toBe("subscription_already_active");

    const portal = await app.inject({
      method: "POST",
      url: "/stores/nx/billing/portal",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(portal.statusCode).toBe(201);
    expect(portal.json().url).toContain("portal.fake");
    expect(gateways.stripePortalSessions[0]?.customerId).toBe("cus_1");
  });

  it("sem assinatura nenhuma o status é none; staff não vê billing", async () => {
    const store = await seedStore();
    const { token } = await registerWithRole(app, "b4@example.org", store.id, "admin");
    const res = await app.inject({
      method: "GET",
      url: "/stores/nx/billing",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "none",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    });

    const { token: staffToken } = await registerWithRole(app, "b5@example.org", store.id, "staff");
    const staffRes = await app.inject({
      method: "GET",
      url: "/stores/nx/billing",
      headers: { authorization: `Bearer ${staffToken}` },
    });
    expect(staffRes.statusCode).toBe(403);
  });

  it("assinatura reusa o customer existente num novo checkout", async () => {
    const store = await seedStore();
    const { token } = await registerWithRole(app, "b6@example.org", store.id, "owner");
    await subscriptionEvent(app, {
      eventId: "evt_cancelada",
      type: "customer.subscription.deleted",
      storeId: store.id,
      status: "canceled",
    });

    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/billing/checkout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(201);
    expect(gateways.stripeSaasCheckouts[0]?.customerId).toBe("cus_1");
  });
});
