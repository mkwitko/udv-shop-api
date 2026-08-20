import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways, type FakeGateways } from "../mocks/gateways.fake.js";

async function staffToken(app: FastifyInstance, email: string, storeId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "St", email, password: "senha-forte-123" },
  });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  await db.userStoreRole.create({ data: { userId: user.id, storeId, role: "staff" } });
  const cookie = res.cookies.find((c) => c.name === "udv_rt")?.value ?? "";
  const refreshed = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    cookies: { udv_rt: cookie },
  });
  return refreshed.json().accessToken as string;
}

async function adminToken(app: FastifyInstance, email: string, storeId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Ad", email, password: "senha-forte-123" },
  });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  await db.userStoreRole.create({ data: { userId: user.id, storeId, role: "admin" } });
  const cookie = res.cookies.find((c) => c.name === "udv_rt")?.value ?? "";
  const refreshed = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    cookies: { udv_rt: cookie },
  });
  return refreshed.json().accessToken as string;
}

describe("sugestão de descrição por IA", () => {
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
    gateways.aiDescriptionCalls.length = 0;
    gateways.aiPrizeCalls.length = 0;
    gateways.aiStoreCalls.length = 0;
  });

  it("staff pede texto e recebe sugestão sem gravar nada no produto", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const token = await staffToken(app, "s@example.org", store.id);

    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/products/description-suggestion",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Caneca Esperança", mode: "improve", draft: "caneca boa" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain("Caneca Esperança");
    expect(gateways.aiDescriptionCalls[0]).toMatchObject({
      productName: "Caneca Esperança",
      mode: "improve",
      draft: "caneca boa",
      storeName: "NX",
    });
    // sugestão é rascunho: nada de produto criado por trás
    expect(await db.product.count()).toBe(0);
  });

  it("quem não é da loja não gasta cota da plataforma", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const outra = await db.store.create({ data: { slug: "ot", name: "OT", status: "active" } });
    const token = await staffToken(app, "de-fora@example.org", outra.id);

    const res = await app.inject({
      method: "POST",
      url: `/stores/${store.slug}/products/description-suggestion`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Caneca", mode: "create" },
    });

    expect(res.statusCode).toBe(403);
    expect(gateways.aiDescriptionCalls).toHaveLength(0);
  });

  it("sem credencial de IA a rota diz que a feature está desligada, não 500", async () => {
    const offline = buildFakeGateways({
      ai: {
        configured: false,
        writeProductDescription: async () => {
          throw new Error("não deveria ser chamado");
        },
        writeCampaignStory: async () => {
          throw new Error("não deveria ser chamado");
        },
        writePrizeDescription: async () => {
          throw new Error("não deveria ser chamado");
        },
        writeStoreDescription: async () => {
          throw new Error("não deveria ser chamado");
        },
      },
    });
    const offlineApp = await buildApp({ gateways: offline });
    await offlineApp.ready();
    try {
      const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
      const token = await staffToken(offlineApp, "s2@example.org", store.id);

      const res = await offlineApp.inject({
        method: "POST",
        url: "/stores/nx/products/description-suggestion",
        headers: { authorization: `Bearer ${token}` },
        payload: { name: "Caneca", mode: "create" },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().message).toBe("ai_not_configured");
    } finally {
      await offlineApp.close();
    }
  });

  it("admin pede descrição de prêmio sem campanha nem sorteio criados", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const token = await adminToken(app, "a@example.org", store.id);

    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/campaigns/prize-description-suggestion",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        prizeTitle: "Cesta de produtos",
        campaignTitle: "Reforma do salão",
        mode: "create",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain("Cesta de produtos");
    expect(gateways.aiPrizeCalls[0]).toMatchObject({
      prizeTitle: "Cesta de produtos",
      campaignTitle: "Reforma do salão",
      mode: "create",
      storeName: "NX",
    });
    expect(await db.campaign.count()).toBe(0);
    expect(await db.rafflePrize.count()).toBe(0);
  });

  it("staff não pede descrição de prêmio (403)", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const token = await staffToken(app, "s3@example.org", store.id);

    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/campaigns/prize-description-suggestion",
      headers: { authorization: `Bearer ${token}` },
      payload: { prizeTitle: "Cesta", mode: "create" },
    });

    expect(res.statusCode).toBe(403);
    expect(gateways.aiPrizeCalls).toHaveLength(0);
  });

  it("descrição de loja não exige loja: basta estar logado", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Pessoa", email: "nova@example.org", password: "senha-forte-123" },
    });
    const token = res.json().accessToken as string;

    const suggestion = await app.inject({
      method: "POST",
      url: "/store-description-suggestion",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Núcleo Esperança", mode: "create", draft: "loja da comunidade" },
    });

    expect(suggestion.statusCode).toBe(200);
    expect(suggestion.json().text).toContain("Núcleo Esperança");
    expect(gateways.aiStoreCalls[0]).toMatchObject({
      storeName: "Núcleo Esperança",
      mode: "create",
      draft: "loja da comunidade",
    });
    expect(await db.store.count()).toBe(0);
  });

  it("descrição de loja exige sessão (401)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/store-description-suggestion",
      payload: { name: "Núcleo Esperança", mode: "create" },
    });

    expect(res.statusCode).toBe(401);
    expect(gateways.aiStoreCalls).toHaveLength(0);
  });
});
