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
    gateways.stripeDashboardLinks.length = 0;
    gateways.stripeAccountSessions.length = 0;
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

  it("POST account-session cria a conta na primeira chamada e devolve client secret", async () => {
    const store = await seedStore();
    const { token } = await registerWithRole(app, "owner-sess@example.org", store.id, "owner");

    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/connect/stripe/account-session",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().clientSecret).toBe("acct_sess_fake_1");
    expect(gateways.stripeConnectedAccounts).toHaveLength(1);
    const persisted = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(persisted.stripeAccountId).toBe("acct_fake_1");

    // segunda chamada reusa a conta: sessão nova, conta a mesma
    const again = await app.inject({
      method: "POST",
      url: "/stores/nx/connect/stripe/account-session",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(again.statusCode).toBe(201);
    expect(gateways.stripeConnectedAccounts).toHaveLength(1);
    expect(gateways.stripeAccountSessions).toEqual(["acct_fake_1", "acct_fake_1"]);
  });

  it("admin não abre account-session (a sessão dá acesso ao onboarding da conta; só owner)", async () => {
    const store = await seedStore();
    const { token } = await registerWithRole(app, "admin-sess@example.org", store.id, "admin");
    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/connect/stripe/account-session",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(gateways.stripeAccountSessions).toHaveLength(0);
  });

  it("POST dashboard devolve login link Express e não vaza o id da conta", async () => {
    const store = await seedStore();
    await db.store.update({
      where: { id: store.id },
      // conta Express só recebe login link depois do onboarding submetido
      data: { stripeAccountId: "acct_express", stripeDetailsSubmitted: true },
    });
    const { token } = await registerWithRole(app, "owner-dash@example.org", store.id, "owner");

    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/connect/stripe/dashboard",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().url).toContain("connect.fake/dashboard");
    expect(JSON.stringify(res.json())).not.toContain("acct_");
    expect(gateways.stripeDashboardLinks).toEqual(["acct_express"]);
  });

  it("POST dashboard antes de terminar o onboarding: 409 e nada de gateway", async () => {
    const store = await seedStore();
    await db.store.update({
      where: { id: store.id },
      data: { stripeAccountId: "acct_express" },
    });
    const { token } = await registerWithRole(app, "owner-dash2@example.org", store.id, "owner");

    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/connect/stripe/dashboard",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe("stripe_onboarding_incomplete");
    expect(gateways.stripeDashboardLinks).toHaveLength(0);
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
    gateways.stripeAccountStatus.transfersEnabled = true;
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
        transfersEnabled: true,
        chargesEnabled: true,
        payoutsEnabled: false,
        detailsSubmitted: true,
      },
      woovi: { connected: false, pixKeyMasked: null, keyStatus: null, ownerName: null },
      // zero é o default desde o ADR-027: plataforma vive da mensalidade, não de comissão
      applicationFeeBps: 0,
      // taxa do provedor não declarada no ambiente: a tela mostra o texto sem número
      providerFees: { pix: null, card: null },
    });
    const persisted = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(persisted.stripeTransfersEnabled).toBe(true);
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
          capabilities: { transfers: "active" },
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
        },
      },
    });
    expect(res.statusCode).toBe(200);

    const persisted = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    // transfers é a capacidade que libera a loja a vender por destination charge
    expect(persisted.stripeTransfersEnabled).toBe(true);
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
    // a chave volta mascarada: a loja reconhece qual salvou, a chave inteira não trafega
    // nasce `pending`: declarar a chave não é provar que ela é sua, e o nome que o Banco
    // Central devolve é o que a loja confere com o olho antes de pagar o centavo
    expect(res.json().woovi).toEqual({
      connected: true,
      pixKeyMasked: "pi***@nucleo.org",
      keyStatus: "pending",
      ownerName: "Dona da Chave",
    });
    expect(JSON.stringify(res.json())).not.toContain("pix@nucleo.org");

    expect(gateways.wooviSubAccounts).toEqual([{ name: "Núcleo X", pixKey: "pix@nucleo.org" }]);
    const persisted = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(persisted.wooviPixKey).toBe("pix@nucleo.org");
    expect(persisted.wooviSubaccountId).toBe("woovi_sub_1");
  });

  it("chave Pix já usada por outra loja é recusada, sem criar subconta nem gravar", async () => {
    const dona = await seedStore();
    await db.store.update({
      where: { id: dona.id },
      data: { wooviPixKey: "pix@nucleo.org", wooviSubaccountId: "woovi_sub_1" },
    });
    // a subconta da Woovi É a chave: gravar a mesma chave aqui daria à segunda loja o
    // saldo da primeira, inclusive o botão de saque
    const outra = await db.store.create({
      data: { slug: "ny", name: "Núcleo Y", status: "pending" },
    });
    const { token } = await registerWithRole(app, "owner-ny@example.org", outra.id, "owner");

    const res = await app.inject({
      method: "PUT",
      url: "/stores/ny/connect/woovi",
      headers: { authorization: `Bearer ${token}` },
      payload: { pixKey: "pix@nucleo.org" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe("woovi_pix_key_taken");
    // recusa antes do gateway: subconta repetida na Woovi é rastro que não se apaga
    expect(gateways.wooviSubAccounts).toEqual([]);
    const persisted = await db.store.findUniqueOrThrow({ where: { id: outra.id } });
    expect(persisted.wooviPixKey).toBeNull();
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
