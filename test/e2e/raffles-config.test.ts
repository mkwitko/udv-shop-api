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

  it("POST cria o sorteio com 3 prêmios (201, sequence 1, open, seed null)", async () => {
    const { store, campaign } = await seedCampaign();
    const { token } = await registerWithRole(app, "admin@example.org", store.id, "admin");
    const res = await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Sorteio",
        centsPerNumber: 1000,
        prizes: [
          { position: 1, title: "Prêmio 1" },
          { position: 2, title: "Prêmio 2" },
          { position: 3, title: "Prêmio 3" },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sequence: 1, status: "open", seed: null, totalEntries: 0 });
    expect(res.json().prizes).toHaveLength(3);
  });

  it("GET lista os sorteios da campanha por sequência", async () => {
    const { store, campaign } = await seedCampaign();
    const { token } = await registerWithRole(app, "admin-list@example.org", store.id, "admin");
    const janelas: Array<[string, string | null]> = [
      ["2026-08-01T03:00:00.000Z", "2026-09-01T03:00:00.000Z"],
      ["2026-09-01T03:00:00.000Z", null],
    ];
    for (const [i, [startsAt, endsAt]] of janelas.entries()) {
      const criado = await app.inject({
        method: "POST",
        url: `/stores/nx/campaigns/${campaign.slug}/raffles`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          title: `Sorteio ${i + 1}`,
          centsPerNumber: 1000,
          startsAt,
          endsAt,
          prizes: [{ position: 1, title: "Cesta" }],
        },
      });
      expect(criado.statusCode).toBe(201);
    }

    const res = await app.inject({
      method: "GET",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((r: { sequence: number }) => r.sequence)).toEqual([1, 2]);
    expect(res.json().items[1]).toMatchObject({ title: "Sorteio 2", endsAt: null });
  });

  it("janela sobreposta → 409 raffle_window_overlap", async () => {
    const { store, campaign } = await seedCampaign();
    const { token } = await registerWithRole(app, "admin-ovl@example.org", store.id, "admin");
    const payload = {
      title: "Agosto",
      centsPerNumber: 1000,
      startsAt: "2026-08-01T03:00:00.000Z",
      endsAt: "2026-09-01T03:00:00.000Z",
      prizes: [{ position: 1, title: "Cesta" }],
    };
    await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    const res = await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ...payload, title: "Sobreposto", startsAt: "2026-08-15T03:00:00.000Z" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe("raffle_window_overlap");
  });

  it("fim antes do início → 400", async () => {
    const { store, campaign } = await seedCampaign();
    const { token } = await registerWithRole(app, "admin-inv@example.org", store.id, "admin");
    const res = await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Invertido",
        centsPerNumber: 1000,
        startsAt: "2026-09-01T03:00:00.000Z",
        endsAt: "2026-08-01T03:00:00.000Z",
        prizes: [{ position: 1, title: "Cesta" }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("sequência inexistente → 404 raffle_not_found", async () => {
    const { store, campaign } = await seedCampaign();
    const { token } = await registerWithRole(app, "admin-404@example.org", store.id, "admin");
    const res = await app.inject({
      method: "GET",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/7`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe("raffle_not_found");
  });

  it("PATCH cancela e reabre o sorteio; realizado recusa com 409", async () => {
    const { store, campaign } = await seedCampaign();
    const { token } = await registerWithRole(app, "admin-cancel@example.org", store.id, "admin");
    const criado = await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Agosto",
        centsPerNumber: 1000,
        startsAt: "2026-08-01T03:00:00.000Z",
        endsAt: "2026-09-01T03:00:00.000Z",
        prizes: [{ position: 1, title: "Cesta" }],
      },
    });
    expect(criado.statusCode).toBe(201);

    const cancelado = await app.inject({
      method: "PATCH",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/1/status`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "cancelled" },
    });
    expect(cancelado.statusCode).toBe(200);
    expect(cancelado.json().status).toBe("cancelled");

    // o substituto pode ocupar a mesma janela do cancelado
    const substituto = await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Agosto de novo",
        centsPerNumber: 1000,
        startsAt: "2026-08-01T03:00:00.000Z",
        endsAt: "2026-09-01T03:00:00.000Z",
        prizes: [{ position: 1, title: "Camiseta" }],
      },
    });
    expect(substituto.statusCode).toBe(201);

    // ...e por isso reabrir o cancelado agora colide
    const reabrir = await app.inject({
      method: "PATCH",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/1/status`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "open" },
    });
    expect(reabrir.statusCode).toBe(409);
    expect(reabrir.json().message).toBe("raffle_window_overlap");

    // sorteio realizado não transita
    await db.raffle.update({
      where: { campaignId_sequence: { campaignId: campaign.id, sequence: 2 } },
      data: { status: "drawn", drawnAt: new Date() },
    });
    const drawn = await app.inject({
      method: "PATCH",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/2/status`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "cancelled" },
    });
    expect(drawn.statusCode).toBe(409);
    expect(drawn.json().message).toBe("invalid_raffle_transition");
  });

  it("staff não cancela sorteio (403)", async () => {
    const { store, campaign } = await seedCampaign();
    const { token: adminToken } = await registerWithRole(
      app,
      "admin-cancel2@example.org",
      store.id,
      "admin",
    );
    await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: "Agosto", centsPerNumber: 1000, prizes: [{ position: 1, title: "Cesta" }] },
    });
    const { token: staffToken } = await registerWithRole(
      app,
      "staff-cancel@example.org",
      store.id,
      "staff",
    );
    const res = await app.inject({
      method: "PATCH",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/1/status`,
      headers: { authorization: `Bearer ${staffToken}` },
      payload: { status: "cancelled" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("prêmio guarda descrição e fotos; GET público devolve imageUrls", async () => {
    const { store, campaign } = await seedCampaign();
    const { token } = await registerWithRole(app, "admin-media@example.org", store.id, "admin");
    const res = await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Sorteio",
        centsPerNumber: 1000,
        prizes: [
          {
            position: 1,
            title: "Cesta de produtos",
            description: "Cesta com café, mel e pão caseiro.",
            images: ["stores/nx/prizes/cesta.jpg"],
          },
          { position: 2, title: "Camiseta bordada" },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().prizes).toMatchObject([
      {
        position: 1,
        description: "Cesta com café, mel e pão caseiro.",
        images: ["stores/nx/prizes/cesta.jpg"],
        imageUrls: ["https://cdn.fake/stores/nx/prizes/cesta.jpg"],
      },
      { position: 2, description: null, images: [], imageUrls: [] },
    ]);

    const publico = await app.inject({
      method: "GET",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/1`,
    });
    expect(publico.statusCode).toBe(200);
    expect(publico.json().prizes[0]).toMatchObject({
      description: "Cesta com café, mel e pão caseiro.",
      imageUrls: ["https://cdn.fake/stores/nx/prizes/cesta.jpg"],
    });
  });

  it("foto de prêmio fora de stores/ → 400", async () => {
    const { store, campaign } = await seedCampaign();
    const { token } = await registerWithRole(app, "admin-key@example.org", store.id, "admin");
    const res = await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Sorteio",
        centsPerNumber: 1000,
        prizes: [{ position: 1, title: "Cesta", images: ["https://evil.example.org/foto.jpg"] }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT de novo substitui os prêmios por inteiro", async () => {
    const { store, campaign } = await seedCampaign();
    const { token } = await registerWithRole(app, "admin2@example.org", store.id, "admin");
    await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Sorteio",
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
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/1`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Sorteio",
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
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Sorteio",
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
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "Sorteio", centsPerNumber: 1000, prizes: [{ position: 1, title: "Aa" }] },
    });
    const raffle = await db.raffle.findUniqueOrThrow({
      where: { campaignId_sequence: { campaignId: campaign.id, sequence: 1 } },
    });
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
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/1`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "Sorteio", centsPerNumber: 2000, prizes: [{ position: 1, title: "Aa" }] },
    });
    expect(changeAmount.statusCode).toBe(409);
    expect(changeAmount.json().message).toBe("raffle_has_entries");

    const changePrizesOnly = await app.inject({
      method: "PUT",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/1`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Sorteio",
        centsPerNumber: 1000,
        prizes: [{ position: 1, title: "Novo título" }],
      },
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
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles`,
      headers: { authorization: `Bearer ${staffToken}` },
      payload: { title: "Sorteio", centsPerNumber: 1000, prizes: [{ position: 1, title: "Aa" }] },
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
      method: "POST",
      url: `/stores/susp/campaigns/${suspendedCampaign.slug}/raffles`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: "Sorteio", centsPerNumber: 1000, prizes: [{ position: 1, title: "Aa" }] },
    });
    expect(suspRes.statusCode).toBe(403);
    expect(suspRes.json().message).toBe("store_suspended");
  });

  it("GET público não mostra seed antes do sorteio e é 404 em campanha draft para anônimo", async () => {
    const { store, campaign } = await seedCampaign();
    const { token } = await registerWithRole(app, "admin6@example.org", store.id, "admin");
    await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "Sorteio", centsPerNumber: 1000, prizes: [{ position: 1, title: "Aa" }] },
    });
    const res = await app.inject({
      method: "GET",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/1`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().seed).toBeNull();

    const draftCampaign = await db.campaign.create({
      data: { storeId: store.id, slug: "rascunho", title: "Rascunho", status: "draft" },
    });
    const draftRes = await app.inject({
      method: "GET",
      url: `/stores/nx/campaigns/${draftCampaign.slug}/raffles/1`,
    });
    expect(draftRes.statusCode).toBe(404);
    expect(draftRes.json().message).toBe("campaign_not_found");
  });

  it("criar sorteio depois de a campanha já ter doações pagas: backfill concede os números de quem doou antes da configuração", async () => {
    const { store, campaign } = await seedCampaign();
    const { token } = await registerWithRole(app, "admin7@example.org", store.id, "admin");
    const { user: doador } = await registerWithRole(app, "doador7@example.org", null, null);
    const donation = await db.donation.create({
      data: {
        storeId: store.id,
        campaignId: campaign.id,
        userId: doador.id,
        type: "one_time",
        amountCents: 5000,
        status: "paid",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Sorteio",
        centsPerNumber: 1000,
        prizes: [{ position: 1, title: "Prêmio" }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().totalEntries).toBe(5);

    expect(
      (await db.donation.findUniqueOrThrow({ where: { id: donation.id } })).raffleGranted,
    ).toBe(true);
    const numbers = await db.raffleEntry.findMany({
      where: { donationId: donation.id },
      orderBy: { number: "asc" },
      select: { number: true },
    });
    expect(numbers.map((n) => n.number)).toEqual([1, 2, 3, 4, 5]);
  });
});
