import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

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
  // Refresh para o access token já carregar roles[storeId].
  const refreshed = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    cookies: { udv_rt: cookie },
  });
  return { token: refreshed.json().accessToken as string, user };
}

async function seedCampaign(status: "active" | "draft" = "active") {
  const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
  const campaign = await db.campaign.create({
    data: { storeId: store.id, slug: "reforma", title: "Reforma", status },
  });
  return { store, campaign };
}

describe("configuração do sorteio", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("PUT cria o sorteio com 3 prêmios (200, open, seed null, totalEntries 0)", async () => {
    const { store, campaign } = await seedCampaign();
    const { token } = await registerWithRole(app, "admin@example.org", store.id, "admin");
    const res = await app.inject({
      method: "PUT",
      url: `/stores/nx/campaigns/${campaign.slug}/raffle`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        centsPerNumber: 1000,
        prizes: [
          { position: 1, title: "Prêmio 1" },
          { position: 2, title: "Prêmio 2" },
          { position: 3, title: "Prêmio 3" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "open", seed: null, totalEntries: 0 });
    expect(res.json().prizes).toHaveLength(3);
  });

  it("PUT de novo substitui os prêmios por inteiro", async () => {
    const { store, campaign } = await seedCampaign();
    const { token } = await registerWithRole(app, "admin2@example.org", store.id, "admin");
    await app.inject({
      method: "PUT",
      url: `/stores/nx/campaigns/${campaign.slug}/raffle`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        centsPerNumber: 1000,
        prizes: [
          { position: 1, title: "Aa" },
          { position: 2, title: "Bb" },
          { position: 3, title: "Cc" },
        ],
      },
    });
    const res = await app.inject({
      method: "PUT",
      url: `/stores/nx/campaigns/${campaign.slug}/raffle`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        centsPerNumber: 1000,
        prizes: [
          { position: 1, title: "Xx" },
          { position: 2, title: "Yy" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().prizes).toHaveLength(2);
  });

  it("posições duplicadas → 400 duplicate_prize_position", async () => {
    const { store, campaign } = await seedCampaign();
    const { token } = await registerWithRole(app, "admin3@example.org", store.id, "admin");
    const res = await app.inject({
      method: "PUT",
      url: `/stores/nx/campaigns/${campaign.slug}/raffle`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        centsPerNumber: 1000,
        prizes: [
          { position: 1, title: "Aa" },
          { position: 1, title: "Bb" },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("duplicate_prize_position");
  });

  it("mudar centsPerNumber com entradas existentes → 409; manter e trocar só prêmios → 200", async () => {
    const { store, campaign } = await seedCampaign();
    const { token } = await registerWithRole(app, "admin4@example.org", store.id, "admin");
    await app.inject({
      method: "PUT",
      url: `/stores/nx/campaigns/${campaign.slug}/raffle`,
      headers: { authorization: `Bearer ${token}` },
      payload: { centsPerNumber: 1000, prizes: [{ position: 1, title: "Aa" }] },
    });
    const raffle = await db.raffle.findUniqueOrThrow({ where: { campaignId: campaign.id } });
    const donor = await db.user.create({
      data: { email: "donor@example.org", name: "Doadora", passwordHash: "x" },
    });
    const donation = await db.donation.create({
      data: {
        storeId: store.id,
        campaignId: campaign.id,
        userId: donor.id,
        amountCents: 1000,
        status: "paid",
      },
    });
    await db.raffleEntry.create({
      data: { raffleId: raffle.id, donationId: donation.id, userId: donor.id, number: 1 },
    });

    const changeAmount = await app.inject({
      method: "PUT",
      url: `/stores/nx/campaigns/${campaign.slug}/raffle`,
      headers: { authorization: `Bearer ${token}` },
      payload: { centsPerNumber: 2000, prizes: [{ position: 1, title: "Aa" }] },
    });
    expect(changeAmount.statusCode).toBe(409);
    expect(changeAmount.json().message).toBe("raffle_has_entries");

    const changePrizesOnly = await app.inject({
      method: "PUT",
      url: `/stores/nx/campaigns/${campaign.slug}/raffle`,
      headers: { authorization: `Bearer ${token}` },
      payload: { centsPerNumber: 1000, prizes: [{ position: 1, title: "Novo título" }] },
    });
    expect(changePrizesOnly.statusCode).toBe(200);
    expect(changePrizesOnly.json().prizes[0].title).toBe("Novo título");
  });

  it("staff não configura → 403; loja suspensa → 403", async () => {
    const { store, campaign } = await seedCampaign();
    const { token: staffToken } = await registerWithRole(
      app,
      "staff@example.org",
      store.id,
      "staff",
    );
    const staffRes = await app.inject({
      method: "PUT",
      url: `/stores/nx/campaigns/${campaign.slug}/raffle`,
      headers: { authorization: `Bearer ${staffToken}` },
      payload: { centsPerNumber: 1000, prizes: [{ position: 1, title: "Aa" }] },
    });
    expect(staffRes.statusCode).toBe(403);

    const suspendedStore = await db.store.create({
      data: { slug: "susp", name: "Susp", status: "suspended" },
    });
    const suspendedCampaign = await db.campaign.create({
      data: { storeId: suspendedStore.id, slug: "c", title: "C", status: "active" },
    });
    const { token: adminToken } = await registerWithRole(
      app,
      "admin5@example.org",
      suspendedStore.id,
      "admin",
    );
    const suspRes = await app.inject({
      method: "PUT",
      url: `/stores/susp/campaigns/${suspendedCampaign.slug}/raffle`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { centsPerNumber: 1000, prizes: [{ position: 1, title: "Aa" }] },
    });
    expect(suspRes.statusCode).toBe(403);
    expect(suspRes.json().message).toBe("store_suspended");
  });

  it("GET público não mostra seed antes do sorteio e é 404 em campanha draft para anônimo", async () => {
    const { store, campaign } = await seedCampaign();
    const { token } = await registerWithRole(app, "admin6@example.org", store.id, "admin");
    await app.inject({
      method: "PUT",
      url: `/stores/nx/campaigns/${campaign.slug}/raffle`,
      headers: { authorization: `Bearer ${token}` },
      payload: { centsPerNumber: 1000, prizes: [{ position: 1, title: "Aa" }] },
    });
    const res = await app.inject({
      method: "GET",
      url: `/stores/nx/campaigns/${campaign.slug}/raffle`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().seed).toBeNull();

    const draftCampaign = await db.campaign.create({
      data: { storeId: store.id, slug: "rascunho", title: "Rascunho", status: "draft" },
    });
    const draftRes = await app.inject({
      method: "GET",
      url: `/stores/nx/campaigns/${draftCampaign.slug}/raffle`,
    });
    expect(draftRes.statusCode).toBe(404);
    expect(draftRes.json().message).toBe("campaign_not_found");
  });
});
