import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { drawWinners } from "../../src/http/api/raffles/draw.js";
import { db } from "../../src/infra/db/client.js";
import { logger } from "../../src/infra/observability/logger.js";
import { relayOutbox } from "../../src/workers/outbox-relay.js";
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

async function seedRaffleWithEntries(
  entryCount: number,
  prizeCount: number,
  opts?: { anonymous?: boolean },
) {
  const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
  const campaign = await db.campaign.create({
    data: { storeId: store.id, slug: "reforma", title: "Reforma", status: "active" },
  });
  const raffle = await db.raffle.create({
    data: {
      campaignId: campaign.id,
      sequence: 1,
      title: "Sorteio",
      startsAt: new Date("2026-01-01T00:00:00Z"),
      centsPerNumber: 1000,
      nextNumber: entryCount + 1,
    },
  });
  for (let i = 1; i <= prizeCount; i++) {
    await db.rafflePrize.create({
      data: { raffleId: raffle.id, position: i, title: `Prêmio ${i}` },
    });
  }
  const entries: { number: number; userId: string }[] = [];
  for (let i = 1; i <= entryCount; i++) {
    const user = await db.user.create({
      data: { email: `doador${i}@example.org`, name: `Doadora ${i} Silva`, passwordHash: "x" },
    });
    const donation = await db.donation.create({
      data: {
        storeId: store.id,
        campaignId: campaign.id,
        userId: user.id,
        amountCents: 1000,
        status: "paid",
        anonymous: opts?.anonymous ?? false,
      },
    });
    await db.raffleEntry.create({
      data: { raffleId: raffle.id, donationId: donation.id, userId: user.id, number: i },
    });
    entries.push({ number: i, userId: user.id });
  }
  return { store, campaign, raffle, entries };
}

describe("sorteio: draw determinístico e listagem pública", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("sorteia com 4 participantes e 2 prêmios (202, seed presente, vencedores distintos e auditáveis)", async () => {
    const { store, campaign } = await seedRaffleWithEntries(4, 2);
    const { token } = await registerWithRole(app, "admin@example.org", store.id, "admin");
    const res = await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/1/draw`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.seed).toMatch(/^[0-9a-f]{32}$/);
    expect(body.prizes).toHaveLength(2);
    const winnerNumbers = body.prizes.map((p: { winner: { number: number } }) => p.winner.number);
    expect(winnerNumbers.every((n: number) => n !== null && n !== undefined)).toBe(true);
    expect(new Set(winnerNumbers).size).toBe(2);

    // Auditabilidade: recalcula drawWinners a partir da seed devolvida e confere
    // que bate com os vencedores gravados.
    const recalculated = drawWinners(body.seed, [1, 2, 3, 4], 2);
    expect(winnerNumbers).toEqual(recalculated);
  });

  it("sortear de novo → 409 raffle_not_open", async () => {
    const { store, campaign } = await seedRaffleWithEntries(4, 2);
    const { token } = await registerWithRole(app, "admin2@example.org", store.id, "admin");
    await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/1/draw`,
      headers: { authorization: `Bearer ${token}` },
    });
    const again = await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/1/draw`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toBe("raffle_not_open");
  });

  it("sortear sem participante → 409 raffle_has_no_entries; sorteio continua open", async () => {
    const { store, campaign } = await seedRaffleWithEntries(0, 2);
    const { token } = await registerWithRole(app, "admin3@example.org", store.id, "admin");
    const res = await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/1/draw`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe("raffle_has_no_entries");
    const fresh = await db.raffle.findUniqueOrThrow({
      where: { campaignId_sequence: { campaignId: campaign.id, sequence: 1 } },
    });
    expect(fresh.status).toBe("open");
    expect(fresh.seed).toBeNull();
  });

  it("GET público depois do sorteio devolve seed, drawnAt e vencedores mascarados; nenhum email no corpo", async () => {
    const { store, campaign } = await seedRaffleWithEntries(4, 2);
    const { token } = await registerWithRole(app, "admin4@example.org", store.id, "admin");
    await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/1/draw`,
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await app.inject({
      method: "GET",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/1`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.seed).toMatch(/^[0-9a-f]{32}$/);
    expect(body.drawnAt).not.toBeNull();
    for (const prize of body.prizes) {
      expect(prize.winner.participant).toBe("Doadora S.");
    }
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("@example.org");
  });

  it("entradas de doação anônima aparecem como 'Doador anônimo' na listagem", async () => {
    const { campaign } = await seedRaffleWithEntries(2, 1, { anonymous: true });
    const res = await app.inject({
      method: "GET",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/1/entries`,
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.json().items.every((e: { participant: string }) => e.participant === "Doador anônimo"),
    ).toBe(true);
  });

  it("staff não sorteia → 403; loja suspensa → 403", async () => {
    const { store, campaign } = await seedRaffleWithEntries(4, 2);
    const { token: staffToken } = await registerWithRole(
      app,
      "staff@example.org",
      store.id,
      "staff",
    );
    const staffRes = await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/1/draw`,
      headers: { authorization: `Bearer ${staffToken}` },
    });
    expect(staffRes.statusCode).toBe(403);

    const suspendedStore = await db.store.create({
      data: { slug: "susp", name: "Susp", status: "suspended" },
    });
    const suspendedCampaign = await db.campaign.create({
      data: { storeId: suspendedStore.id, slug: "c", title: "Campanha", status: "active" },
    });
    await db.raffle.create({
      data: {
        campaignId: suspendedCampaign.id,
        sequence: 1,
        title: "Sorteio",
        startsAt: new Date("2026-01-01T00:00:00Z"),
        centsPerNumber: 1000,
      },
    });
    const { token: adminToken } = await registerWithRole(
      app,
      "admin5@example.org",
      suspendedStore.id,
      "admin",
    );
    const suspRes = await app.inject({
      method: "POST",
      url: `/stores/susp/campaigns/${suspendedCampaign.slug}/raffles/1/draw`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(suspRes.statusCode).toBe(403);
    expect(suspRes.json().message).toBe("store_suspended");
  });

  it("relay processa raffle.drawn e manda um email por prêmio contemplado", async () => {
    const { store, campaign, raffle } = await seedRaffleWithEntries(4, 2);
    const { token } = await registerWithRole(app, "admin6@example.org", store.id, "admin");
    await app.inject({
      method: "POST",
      url: `/stores/nx/campaigns/${campaign.slug}/raffles/1/draw`,
      headers: { authorization: `Bearer ${token}` },
    });
    const outboxEvent = await db.outboxEvent.findFirstOrThrow({
      where: { type: "raffle.drawn" },
    });
    expect((outboxEvent.payload as { raffleId: string }).raffleId).toBe(raffle.id);

    const gateways = buildFakeGateways();
    const n = await relayOutbox({
      db,
      email: gateways.email,
      woovi: gateways.woovi,
      stripe: gateways.stripe,
      log: logger,
    });
    expect(n).toBe(1);
    expect(gateways.sentEmails).toHaveLength(2);
    for (const email of gateways.sentEmails) {
      expect(email.subject).toContain("Você foi sorteado");
    }
  });
});
