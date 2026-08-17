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
