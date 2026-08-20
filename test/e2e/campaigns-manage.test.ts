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

describe("gestão de campanhas", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("admin cria campanha (201, status draft); slug duplicado 409", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const { token } = await registerWithRole(app, "admin@example.org", store.id, "admin");
    const body = { slug: "reforma", title: "Reforma do salão", goalCents: 500_000 };
    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/campaigns",
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      slug: "reforma",
      title: "Reforma do salão",
      status: "draft",
      goalCents: 500_000,
      raisedCents: 0,
      donationCount: 0,
      acceptedTypes: "both",
    });

    const dup = await app.inject({
      method: "POST",
      url: "/stores/nx/campaigns",
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().message).toBe("campaign_slug_taken");
  });

  it("cria campanha com sorteio e prêmios na mesma chamada", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const { token } = await registerWithRole(app, "admin-raffle@example.org", store.id, "admin");
    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/campaigns",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        slug: "reforma",
        title: "Reforma do salão",
        coverImage: "stores/nx/campaigns/capa.jpg",
        raffle: {
          centsPerNumber: 1000,
          prizes: [
            {
              position: 1,
              title: "Cesta de produtos",
              description: "Café, mel e pão caseiro.",
              images: ["stores/nx/prizes/cesta.jpg"],
            },
            { position: 2, title: "Camiseta bordada" },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: "draft",
      coverImage: "stores/nx/campaigns/capa.jpg",
      coverImageUrl: "https://cdn.fake/stores/nx/campaigns/capa.jpg",
    });

    const raffle = await app.inject({
      method: "GET",
      url: "/stores/nx/campaigns/reforma/raffle",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(raffle.statusCode).toBe(200);
    expect(raffle.json()).toMatchObject({ status: "open", centsPerNumber: 1000 });
    expect(raffle.json().prizes).toMatchObject([
      {
        position: 1,
        title: "Cesta de produtos",
        description: "Café, mel e pão caseiro.",
        imageUrls: ["https://cdn.fake/stores/nx/prizes/cesta.jpg"],
      },
      { position: 2, title: "Camiseta bordada", description: null, images: [] },
    ]);
  });

  it("sorteio inválido na criação não deixa campanha órfã", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const { token } = await registerWithRole(app, "admin-dup@example.org", store.id, "admin");
    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/campaigns",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        slug: "reforma",
        title: "Reforma do salão",
        raffle: {
          centsPerNumber: 1000,
          prizes: [
            { position: 1, title: "Aa" },
            { position: 1, title: "Bb" },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("duplicate_prize_position");
    expect(await db.campaign.count({ where: { storeId: store.id } })).toBe(0);
  });

  it("staff não cria campanha (403)", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const { token } = await registerWithRole(app, "staff@example.org", store.id, "staff");
    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/campaigns",
      headers: { authorization: `Bearer ${token}` },
      payload: { slug: "reforma", title: "Reforma do salão" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("loja suspensa → criar campanha 403 store_suspended", async () => {
    const store = await db.store.create({
      data: { slug: "nx", name: "NX", status: "suspended" },
    });
    const { token } = await registerWithRole(app, "adm@example.org", store.id, "admin");
    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/campaigns",
      headers: { authorization: `Bearer ${token}` },
      payload: { slug: "reforma", title: "Reforma do salão" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("store_suspended");
  });

  it("update ignora slug e altera título/meta", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const { token } = await registerWithRole(app, "adm2@example.org", store.id, "admin");
    await app.inject({
      method: "POST",
      url: "/stores/nx/campaigns",
      headers: { authorization: `Bearer ${token}` },
      payload: { slug: "reforma", title: "Reforma do salão", goalCents: 500_000 },
    });

    const upd = await app.inject({
      method: "PATCH",
      url: "/stores/nx/campaigns/reforma",
      headers: { authorization: `Bearer ${token}` },
      payload: { slug: "outro-slug", title: "Reforma completa", goalCents: 900_000 },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json()).toMatchObject({
      slug: "reforma",
      title: "Reforma completa",
      goalCents: 900_000,
    });
  });

  it("transição draft → finished é 409 invalid_campaign_transition", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const { token } = await registerWithRole(app, "adm3@example.org", store.id, "admin");
    await app.inject({
      method: "POST",
      url: "/stores/nx/campaigns",
      headers: { authorization: `Bearer ${token}` },
      payload: { slug: "reforma", title: "Reforma do salão" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/stores/nx/campaigns/reforma/status",
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "finished" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe("invalid_campaign_transition");
  });

  it("transição draft → active → paused → finished (200 em cada)", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const { token } = await registerWithRole(app, "adm4@example.org", store.id, "admin");
    await app.inject({
      method: "POST",
      url: "/stores/nx/campaigns",
      headers: { authorization: `Bearer ${token}` },
      payload: { slug: "reforma", title: "Reforma do salão" },
    });

    for (const status of ["active", "paused", "finished"]) {
      const res = await app.inject({
        method: "PATCH",
        url: "/stores/nx/campaigns/reforma/status",
        headers: { authorization: `Bearer ${token}` },
        payload: { status },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe(status);
    }
  });

  it("campanha de outra loja → 404 campaign_not_found", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const outra = await db.store.create({ data: { slug: "ny", name: "NY", status: "active" } });
    await db.campaign.create({
      data: { storeId: outra.id, slug: "reforma", title: "Reforma de outra loja" },
    });
    const { token } = await registerWithRole(app, "adm5@example.org", store.id, "admin");
    const res = await app.inject({
      method: "PATCH",
      url: "/stores/nx/campaigns/reforma",
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "Tentativa" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe("campaign_not_found");
  });
});

describe("sugestão de história por IA", () => {
  let app: FastifyInstance;
  let gateways: ReturnType<typeof buildFakeGateways>;

  beforeAll(async () => {
    gateways = buildFakeGateways();
    app = await buildApp({ gateways });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    gateways.aiStoryCalls.length = 0;
  });

  it("admin recebe sugestão com o contexto que mandou", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const { token } = await registerWithRole(app, "adm@example.org", store.id, "admin");

    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/campaigns/story-suggestion",
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "Troca do telhado", mode: "improve", draft: "o telhado ta furado" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain("Troca do telhado");
    expect(gateways.aiStoryCalls[0]).toMatchObject({
      campaignTitle: "Troca do telhado",
      mode: "improve",
      draft: "o telhado ta furado",
      storeName: "NX",
    });
    // sugestão não cria campanha nenhuma
    expect(await db.campaign.count()).toBe(0);
  });

  it("staff não gasta cota: a rota é de owner/admin", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const { token } = await registerWithRole(app, "st@example.org", store.id, "staff");

    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/campaigns/story-suggestion",
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "Troca do telhado", mode: "create" },
    });

    expect(res.statusCode).toBe(403);
    expect(gateways.aiStoryCalls).toHaveLength(0);
  });
});
