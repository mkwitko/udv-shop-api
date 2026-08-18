import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways, type FakeGateways } from "../mocks/gateways.fake.js";

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

describe("connect — onboarding Stripe e subconta Woovi", () => {
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
    gateways.stripeConnectedAccounts.length = 0;
    gateways.stripeAccountLinks.length = 0;
    gateways.wooviSubAccounts.length = 0;
    gateways.stripeAccountStatus.chargesEnabled = false;
    gateways.stripeAccountStatus.payoutsEnabled = false;
    gateways.stripeAccountStatus.detailsSubmitted = false;
  });

  it("POST link cria a conta conectada uma única vez e devolve um link novo a cada chamada", async () => {
    const store = await seedStore();
    const { token } = await registerWithRole(app, "owner1@example.org", store.id, "owner");

    const first = await app.inject({
      method: "POST",
      url: "/stores/nx/connect/stripe/link",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().url).toContain("connect.fake");
    // Nada de id de conta na resposta.
    expect(JSON.stringify(first.json())).not.toContain("acct_");

    const second = await app.inject({
      method: "POST",
      url: "/stores/nx/connect/stripe/link",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.statusCode).toBe(201);

    expect(gateways.stripeConnectedAccounts).toHaveLength(1);
    expect(gateways.stripeAccountLinks).toHaveLength(2);
    const persisted = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(persisted.stripeAccountId).toBe("acct_fake_1");
  });

  it("admin e staff não iniciam o onboarding (só owner)", async () => {
    const store = await seedStore();
    const { token: adminToken } = await registerWithRole(
      app,
      "admin1@example.org",
      store.id,
      "admin",
    );
    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/connect/stripe/link",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /connect com onboarding pendente relê o Stripe e persiste as capacidades", async () => {
    const store = await seedStore();
    await db.store.update({ where: { id: store.id }, data: { stripeAccountId: "acct_x" } });
    const { token } = await registerWithRole(app, "owner2@example.org", store.id, "owner");
    gateways.stripeAccountStatus.chargesEnabled = true;
    gateways.stripeAccountStatus.detailsSubmitted = true;

    const res = await app.inject({
      method: "GET",
      url: "/stores/nx/connect",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      stripe: {
        connected: true,
        chargesEnabled: true,
        payoutsEnabled: false,
        detailsSubmitted: true,
      },
      woovi: { connected: false },
      // taxa real da loja vai para a tela de recebimento (§27: nada de "100% grátis")
      applicationFeeBps: 500,
    });
    const persisted = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(persisted.stripeChargesEnabled).toBe(true);
    expect(persisted.stripeDetailsSubmitted).toBe(true);
  });

  it("webhook account.updated liga as capacidades da loja dona daquela conta", async () => {
    const store = await seedStore();
    await db.store.update({ where: { id: store.id }, data: { stripeAccountId: "acct_hook" } });

    const res = await stripeEvent(app, {
      id: "evt_acct",
      type: "account.updated",
      account: "acct_hook",
      data: {
        object: {
          id: "acct_hook",
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
        },
      },
    });
    expect(res.statusCode).toBe(200);

    const persisted = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(persisted.stripeChargesEnabled).toBe(true);
    expect(persisted.stripePayoutsEnabled).toBe(true);
    expect(persisted.stripeDetailsSubmitted).toBe(true);
  });

  it("account.updated de conta que não é de nenhuma loja não falha o evento", async () => {
    const res = await stripeEvent(app, {
      id: "evt_acct_orfa",
      type: "account.updated",
      account: "acct_desconhecida",
      data: { object: { id: "acct_desconhecida", charges_enabled: true } },
    });
    expect(res.statusCode).toBe(200);
    const event = await db.webhookEvent.findFirstOrThrow({ where: { eventId: "evt_acct_orfa" } });
    expect(event.status).toBe("processed");
  });

  it("PUT woovi cria a subconta antes de gravar e não devolve a chave Pix", async () => {
    const store = await seedStore();
    const { token } = await registerWithRole(app, "owner3@example.org", store.id, "owner");

    const res = await app.inject({
      method: "PUT",
      url: "/stores/nx/connect/woovi",
      headers: { authorization: `Bearer ${token}` },
      payload: { pixKey: "pix@nucleo.org" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().woovi).toEqual({ connected: true });
    expect(JSON.stringify(res.json())).not.toContain("pix@nucleo.org");

    expect(gateways.wooviSubAccounts).toEqual([{ name: "Núcleo X", pixKey: "pix@nucleo.org" }]);
    const persisted = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(persisted.wooviPixKey).toBe("pix@nucleo.org");
    expect(persisted.wooviSubaccountId).toBe("woovi_sub_1");
  });

  it("loja suspensa não inicia onboarding", async () => {
    const store = await seedStore();
    await db.store.update({ where: { id: store.id }, data: { status: "suspended" } });
    const { token } = await registerWithRole(app, "owner4@example.org", store.id, "owner");
    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/connect/stripe/link",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("store_suspended");
  });
});
