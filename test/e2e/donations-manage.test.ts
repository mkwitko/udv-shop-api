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
  const refreshed = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    cookies: { udv_rt: cookie },
  });
  return { token: refreshed.json().accessToken as string, user };
}

async function seedStores() {
  const store1 = await db.store.create({
    data: {
      slug: "nucleo-a",
      name: "Núcleo A",
      status: "active",
      applicationFeeBps: 500,
      stripeAccountId: "acct_1234567890",
    },
  });
  const store2 = await db.store.create({
    data: {
      slug: "nucleo-b",
      name: "Núcleo B",
      status: "active",
      applicationFeeBps: 300,
      stripeAccountId: "acct_0987654321",
    },
  });
  return { store1, store2 };
}

async function seedCampaign(storeId: string, slug: string = "reforma") {
  return db.campaign.create({
    data: {
      storeId,
      slug,
      title: "Reforma do salão",
      status: "active",
    },
  });
}

async function seedDonation(
  userId: string,
  storeId: string,
  campaignId: string | null = null,
  overrides: Record<string, unknown> = {},
) {
  return db.donation.create({
    data: {
      userId,
      storeId,
      campaignId,
      type: "one_time",
      amountCents: 10_000,
      currency: "BRL",
      status: "paid",
      anonymous: false,
      payment: {
        create: {
          provider: "stripe",
          amountCents: 10_000,
          applicationFeeCents: 500,
          status: "succeeded",
        },
      },
      ...overrides,
    },
    include: {
      store: { select: { slug: true, name: true } },
      campaign: { select: { slug: true, title: true } },
      payment: { select: { id: true, provider: true, status: true } },
      entries: { select: { number: true }, orderBy: { number: "asc" } },
      user: { select: { name: true, email: true, phone: true } },
    },
  });
}

describe("GET /stores/:slug/donations", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("staff lista as doações da loja com donor.name e donor.email", async () => {
    const { store1 } = await seedStores();
    const { token } = await registerWithRole(app, "staff@example.org", store1.id, "staff");

    const donor1 = await db.user.create({
      data: { email: "donor1@example.org", name: "Doador Um", passwordHash: "x" },
    });
    const donor2 = await db.user.create({
      data: { email: "donor2@example.org", name: "Doador Dois", passwordHash: "x" },
    });

    await seedDonation(donor1.id, store1.id);
    await seedDonation(donor2.id, store1.id);

    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/donations?limit=50",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveProperty("donor");
    const donorNames = new Set(items.map((item: { donor: { name: string } }) => item.donor.name));
    expect(donorNames).toContain("Doador Um");
    expect(donorNames).toContain("Doador Dois");
    const donorEmails = new Set(
      items.map((item: { donor: { email: string } }) => item.donor.email),
    );
    expect(donorEmails).toContain("donor1@example.org");
    expect(donorEmails).toContain("donor2@example.org");
  });

  it("lista de uma loja não vaza doação de outra loja", async () => {
    const { store1, store2 } = await seedStores();
    const { token } = await registerWithRole(app, "staff@example.org", store1.id, "staff");

    const donor1 = await db.user.create({
      data: { email: "d1@example.org", name: "D1", passwordHash: "x" },
    });
    const donor2 = await db.user.create({
      data: { email: "d2@example.org", name: "D2", passwordHash: "x" },
    });

    await seedDonation(donor1.id, store1.id);
    await seedDonation(donor1.id, store1.id);
    await seedDonation(donor2.id, store2.id);
    await seedDonation(donor2.id, store2.id);

    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/donations?limit=50",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(2);
    expect(await db.donation.count()).toBe(4);
  });

  it("filtra por campaignSlug", async () => {
    const { store1 } = await seedStores();
    const { token } = await registerWithRole(app, "staff@example.org", store1.id, "staff");

    const campaign1 = await seedCampaign(store1.id, "reforma");
    const campaign2 = await seedCampaign(store1.id, "pintura");

    const donor = await db.user.create({
      data: { email: "donor@example.org", name: "Donor", passwordHash: "x" },
    });

    await seedDonation(donor.id, store1.id, campaign1.id);
    await seedDonation(donor.id, store1.id, campaign1.id);
    await seedDonation(donor.id, store1.id, campaign2.id);
    await seedDonation(donor.id, store1.id, null);

    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/donations?campaignSlug=reforma",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(2);
  });

  it("campaignSlug inexistente → 404", async () => {
    const { store1 } = await seedStores();
    const { token } = await registerWithRole(app, "staff@example.org", store1.id, "staff");

    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/donations?campaignSlug=nao-existe",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe("campaign_not_found");
  });

  it("cliente sem papel na loja → 403", async () => {
    await seedStores();
    const { token } = await registerWithRole(app, "customer@example.org", null, null);

    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/donations",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("membro de outra loja → 403", async () => {
    const { store2 } = await seedStores();
    const { token } = await registerWithRole(app, "other@example.org", store2.id, "staff");

    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/donations",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("teste de vazamento: applicationFeeBps e stripeAccountId não vazam", async () => {
    const { store1 } = await seedStores();
    const { token } = await registerWithRole(app, "staff@example.org", store1.id, "staff");

    const donor = await db.user.create({
      data: { email: "donor@example.org", name: "Donor", passwordHash: "x" },
    });

    await seedDonation(donor.id, store1.id);

    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/donations?limit=50",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const json = JSON.stringify(res.json());
    expect(json).not.toContain("applicationFeeBps");
    expect(json).not.toContain("applicationFeeCents");
    expect(json).not.toContain("stripeAccountId");
    expect(json).not.toContain("acct_");
  });
});
