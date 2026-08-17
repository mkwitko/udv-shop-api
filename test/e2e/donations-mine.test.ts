import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

async function register(app: FastifyInstance, email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Doador", email, password: "senha-forte-123" },
  });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  return { token: res.json().accessToken as string, user };
}

async function seedStore() {
  return db.store.create({
    data: {
      slug: "nucleo-a",
      name: "Núcleo A",
      status: "active",
      applicationFeeBps: 500,
    },
  });
}

async function seedDonation(
  userId: string,
  storeId: string,
  overrides: Record<string, unknown> = {},
) {
  return db.donation.create({
    data: {
      userId,
      storeId,
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
    },
  });
}

describe("GET /donations", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("lista só as próprias doações", async () => {
    const store = await seedStore();
    const { token, user: user1 } = await register(app, "d1@example.org");
    const { user: user2 } = await register(app, "d2@example.org");

    // Seed: 3 doações para user1, 2 para user2
    await seedDonation(user1.id, store.id);
    await seedDonation(user1.id, store.id);
    await seedDonation(user1.id, store.id);
    await seedDonation(user2.id, store.id);
    await seedDonation(user2.id, store.id);

    const res = await app.inject({
      method: "GET",
      url: "/donations?limit=50",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.items).toHaveLength(3);
    expect(await db.donation.count()).toBe(5);
  });

  it("filtra por status", async () => {
    const store = await seedStore();
    const { token, user } = await register(app, "f@example.org");

    await seedDonation(user.id, store.id, { status: "paid" });
    await seedDonation(user.id, store.id, { status: "paid" });
    await seedDonation(user.id, store.id, { status: "cancelled" });

    const res = await app.inject({
      method: "GET",
      url: "/donations?status=paid",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(2);
  });

  it("paginação por cursor com limit=1", async () => {
    const store = await seedStore();
    const { token, user } = await register(app, "p@example.org");

    // Seed 3 doações
    await seedDonation(user.id, store.id);
    await seedDonation(user.id, store.id);
    await seedDonation(user.id, store.id);

    const res1 = await app.inject({
      method: "GET",
      url: "/donations?limit=1",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res1.json().items).toHaveLength(1);
    const cursor1 = res1.json().nextCursor;
    expect(cursor1).not.toBeNull();

    const res2 = await app.inject({
      method: "GET",
      url: `/donations?limit=1&cursor=${cursor1}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res2.json().items).toHaveLength(1);
    const cursor2 = res2.json().nextCursor;
    expect(cursor2).not.toBeNull();

    const res3 = await app.inject({
      method: "GET",
      url: `/donations?limit=1&cursor=${cursor2}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res3.json().items).toHaveLength(1);
    expect(res3.json().nextCursor).toBeNull();
  });

  it("raffleNumbers é vazio por padrão", async () => {
    const store = await seedStore();
    const { token, user } = await register(app, "r@example.org");

    await seedDonation(user.id, store.id);

    const res = await app.inject({
      method: "GET",
      url: "/donations?limit=50",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(1);
    expect(items[0].raffleNumbers).toEqual([]);
  });

  it("subscriptionActive é false para one_time", async () => {
    const store = await seedStore();
    const { token, user } = await register(app, "s1@example.org");

    await seedDonation(user.id, store.id, { type: "one_time" });

    const res = await app.inject({
      method: "GET",
      url: "/donations",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().items[0].subscriptionActive).toBe(false);
  });

  it("subscriptionActive é false para mensal cancelada", async () => {
    const store = await seedStore();
    const { token, user } = await register(app, "s2@example.org");

    await seedDonation(user.id, store.id, {
      type: "monthly",
      subscriptionRef: "sub_123",
      subscriptionCancelledAt: new Date(),
    });

    const res = await app.inject({
      method: "GET",
      url: "/donations",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().items[0].subscriptionActive).toBe(false);
  });
});

describe("GET /donations/:id", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("retorna a própria doação", async () => {
    const store = await seedStore();
    const { token, user } = await register(app, "own@example.org");

    const donation = await seedDonation(user.id, store.id);

    const res = await app.inject({
      method: "GET",
      url: `/donations/${donation.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(donation.id);
  });

  it("doação alheia → 404", async () => {
    const store = await seedStore();
    const { token } = await register(app, "me@example.org");
    const { user: other } = await register(app, "other@example.org");

    const donation = await seedDonation(other.id, store.id);

    const res = await app.inject({
      method: "GET",
      url: `/donations/${donation.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe("donation_not_found");
  });

  it("doação inexistente → 404", async () => {
    const { token } = await register(app, "fake@example.org");

    const res = await app.inject({
      method: "GET",
      url: "/donations/550e8400-e29b-41d4-a716-446655440000",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe("donation_not_found");
  });
});
