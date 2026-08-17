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

describe("leitura pública de campanhas", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("lista pública não traz draft; ?all=true sem token também não traz", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    await db.campaign.create({
      data: { storeId: store.id, slug: "ativa", title: "Ativa", status: "active" },
    });
    await db.campaign.create({
      data: { storeId: store.id, slug: "rascunho", title: "Rascunho", status: "draft" },
    });

    const list = await app.inject({ method: "GET", url: "/stores/nx/campaigns" });
    expect(list.statusCode).toBe(200);
    const slugs = list.json().items.map((c: { slug: string }) => c.slug);
    expect(slugs).toEqual(["ativa"]);

    const withAll = await app.inject({ method: "GET", url: "/stores/nx/campaigns?all=true" });
    expect(withAll.statusCode).toBe(200);
    const slugsAll = withAll.json().items.map((c: { slug: string }) => c.slug);
    expect(slugsAll).toEqual(["ativa"]);
  });

  it("?all=true com token de staff traz o draft", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    await db.campaign.create({
      data: { storeId: store.id, slug: "ativa", title: "Ativa", status: "active" },
    });
    await db.campaign.create({
      data: { storeId: store.id, slug: "rascunho", title: "Rascunho", status: "draft" },
    });
    const { token } = await registerWithRole(app, "staff@example.org", store.id, "staff");

    const res = await app.inject({
      method: "GET",
      url: "/stores/nx/campaigns?all=true",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const slugs = res.json().items.map((c: { slug: string }) => c.slug);
    expect(slugs.sort()).toEqual(["ativa", "rascunho"]);
  });

  it("GET de campanha draft é 404 para anônimo e 200 para staff", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    await db.campaign.create({
      data: { storeId: store.id, slug: "rascunho", title: "Rascunho", status: "draft" },
    });
    const { token } = await registerWithRole(app, "staff2@example.org", store.id, "staff");

    const anon = await app.inject({ method: "GET", url: "/stores/nx/campaigns/rascunho" });
    expect(anon.statusCode).toBe(404);
    expect(anon.json().message).toBe("campaign_not_found");

    const staff = await app.inject({
      method: "GET",
      url: "/stores/nx/campaigns/rascunho",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(staff.statusCode).toBe(200);
    expect(staff.json().slug).toBe("rascunho");
  });

  it("raisedCents/donationCount somam só doações paid, por campanha", async () => {
    const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
    const user = await db.user.create({
      data: { email: "doador@example.org", name: "Doadora", passwordHash: "x" },
    });
    const campaign = await db.campaign.create({
      data: { storeId: store.id, slug: "reforma", title: "Reforma", status: "active" },
    });
    const outraCampanha = await db.campaign.create({
      data: { storeId: store.id, slug: "outra", title: "Outra", status: "active" },
    });
    await db.donation.create({
      data: {
        storeId: store.id,
        campaignId: campaign.id,
        userId: user.id,
        amountCents: 5000,
        status: "paid",
      },
    });
    await db.donation.create({
      data: {
        storeId: store.id,
        campaignId: campaign.id,
        userId: user.id,
        amountCents: 3000,
        status: "pending_payment",
      },
    });
    await db.donation.create({
      data: {
        storeId: store.id,
        campaignId: campaign.id,
        userId: user.id,
        amountCents: 7000,
        status: "cancelled",
      },
    });
    await db.donation.create({
      data: {
        storeId: store.id,
        campaignId: outraCampanha.id,
        userId: user.id,
        amountCents: 9000,
        status: "paid",
      },
    });

    const res = await app.inject({ method: "GET", url: "/stores/nx/campaigns/reforma" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ raisedCents: 5000, donationCount: 1 });
  });

  it("loja pending é 404 para anônimo", async () => {
    await db.store.create({ data: { slug: "nx", name: "NX", status: "pending" } });
    const res = await app.inject({ method: "GET", url: "/stores/nx/campaigns" });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe("store_not_found");
  });
});
