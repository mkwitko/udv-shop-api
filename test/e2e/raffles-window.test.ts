import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createRafflesRepository } from "../../src/http/api/raffles/raffles.repository.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

const AGOSTO = new Date("2026-08-01T03:00:00Z");
const SETEMBRO = new Date("2026-09-01T03:00:00Z");
const OUTUBRO = new Date("2026-10-01T03:00:00Z");

async function seedCampaign() {
  const store = await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } });
  const campaign = await db.campaign.create({
    data: { storeId: store.id, slug: "reforma", title: "Reforma", status: "active" },
  });
  const donor = await db.user.create({
    data: { email: "donor@example.org", name: "Maria Silva", passwordHash: "x" },
  });
  return { store, campaign, donor };
}

async function seedRaffle(input: {
  campaignId: string;
  sequence: number;
  startsAt: Date;
  endsAt: Date | null;
  status?: "open" | "drawn";
}) {
  return db.raffle.create({
    data: {
      campaignId: input.campaignId,
      sequence: input.sequence,
      title: `Sorteio ${input.sequence}`,
      centsPerNumber: 1000,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: input.status ?? "open",
    },
  });
}

async function seedPaidDonation(input: {
  storeId: string;
  campaignId: string;
  userId: string;
  paidAt: Date;
  amountCents?: number;
}) {
  return db.donation.create({
    data: {
      storeId: input.storeId,
      campaignId: input.campaignId,
      userId: input.userId,
      type: "one_time",
      amountCents: input.amountCents ?? 5000,
      status: "paid",
      paidAt: input.paidAt,
    },
  });
}

describe("janela do sorteio", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("doação paga na janela do 2º sorteio gera números só nele", async () => {
    const { store, campaign, donor } = await seedCampaign();
    const um = await seedRaffle({
      campaignId: campaign.id,
      sequence: 1,
      startsAt: AGOSTO,
      endsAt: SETEMBRO,
    });
    const dois = await seedRaffle({
      campaignId: campaign.id,
      sequence: 2,
      startsAt: SETEMBRO,
      endsAt: OUTUBRO,
    });
    const donation = await seedPaidDonation({
      storeId: store.id,
      campaignId: campaign.id,
      userId: donor.id,
      paidAt: new Date("2026-09-10T12:00:00Z"),
    });

    const granted = await createRafflesRepository(db).grantNumbersForDonation(donation.id, app.log);

    expect(granted).toBe(5);
    expect(await db.raffleEntry.count({ where: { raffleId: dois.id } })).toBe(5);
    expect(await db.raffleEntry.count({ where: { raffleId: um.id } })).toBe(0);
  });

  it("doação da janela de um sorteio já realizado não gera número em nenhum outro", async () => {
    const { store, campaign, donor } = await seedCampaign();
    await seedRaffle({
      campaignId: campaign.id,
      sequence: 1,
      startsAt: AGOSTO,
      endsAt: SETEMBRO,
      status: "drawn",
    });
    const dois = await seedRaffle({
      campaignId: campaign.id,
      sequence: 2,
      startsAt: SETEMBRO,
      endsAt: null,
    });
    const donation = await seedPaidDonation({
      storeId: store.id,
      campaignId: campaign.id,
      userId: donor.id,
      paidAt: new Date("2026-08-15T12:00:00Z"),
    });

    const granted = await createRafflesRepository(db).grantNumbersForDonation(donation.id, app.log);

    expect(granted).toBe(0);
    expect(await db.raffleEntry.count({ where: { raffleId: dois.id } })).toBe(0);
    // continua elegível: nenhum sorteio a reivindicou
    expect(
      (await db.donation.findUniqueOrThrow({ where: { id: donation.id } })).raffleGranted,
    ).toBe(false);
  });

  it("doação num vão entra no próximo sorteio que começa", async () => {
    const { store, campaign, donor } = await seedCampaign();
    const setembro = await seedRaffle({
      campaignId: campaign.id,
      sequence: 1,
      startsAt: SETEMBRO,
      endsAt: OUTUBRO,
    });
    // paga em agosto: antes de qualquer janela
    const donation = await seedPaidDonation({
      storeId: store.id,
      campaignId: campaign.id,
      userId: donor.id,
      paidAt: AGOSTO,
    });

    const granted = await createRafflesRepository(db).grantNumbersForDonation(donation.id, app.log);

    expect(granted).toBe(5);
    expect(await db.raffleEntry.count({ where: { raffleId: setembro.id } })).toBe(5);
  });

  it("doação sem sorteio nenhum fica pendente, sem marcar raffleGranted", async () => {
    const { store, campaign, donor } = await seedCampaign();
    const donation = await seedPaidDonation({
      storeId: store.id,
      campaignId: campaign.id,
      userId: donor.id,
      paidAt: AGOSTO,
    });

    const granted = await createRafflesRepository(db).grantNumbersForDonation(donation.id, app.log);

    expect(granted).toBe(0);
    expect(
      (await db.donation.findUniqueOrThrow({ where: { id: donation.id } })).raffleGranted,
    ).toBe(false);
  });

  it("cada sorteio numera a partir de 1", async () => {
    const { store, campaign, donor } = await seedCampaign();
    const um = await seedRaffle({
      campaignId: campaign.id,
      sequence: 1,
      startsAt: AGOSTO,
      endsAt: SETEMBRO,
    });
    const dois = await seedRaffle({
      campaignId: campaign.id,
      sequence: 2,
      startsAt: SETEMBRO,
      endsAt: null,
    });
    const repo = createRafflesRepository(db);
    const emAgosto = await seedPaidDonation({
      storeId: store.id,
      campaignId: campaign.id,
      userId: donor.id,
      paidAt: new Date("2026-08-10T12:00:00Z"),
      amountCents: 2000,
    });
    const emSetembro = await seedPaidDonation({
      storeId: store.id,
      campaignId: campaign.id,
      userId: donor.id,
      paidAt: new Date("2026-09-10T12:00:00Z"),
      amountCents: 2000,
    });
    await repo.grantNumbersForDonation(emAgosto.id, app.log);
    await repo.grantNumbersForDonation(emSetembro.id, app.log);

    const numerosUm = await db.raffleEntry.findMany({
      where: { raffleId: um.id },
      select: { number: true },
      orderBy: { number: "asc" },
    });
    const numerosDois = await db.raffleEntry.findMany({
      where: { raffleId: dois.id },
      select: { number: true },
      orderBy: { number: "asc" },
    });
    expect(numerosUm.map((n) => n.number)).toEqual([1, 2]);
    expect(numerosDois.map((n) => n.number)).toEqual([1, 2]);
  });

  it("criar sorteio novo concede números às doações pendentes que caem nele", async () => {
    const { store, campaign, donor } = await seedCampaign();
    const pendente = await seedPaidDonation({
      storeId: store.id,
      campaignId: campaign.id,
      userId: donor.id,
      paidAt: new Date("2026-09-10T12:00:00Z"),
      amountCents: 4000,
    });

    const raffle = await createRafflesRepository(db).create({
      campaignId: campaign.id,
      title: "Sorteio de setembro",
      centsPerNumber: 1000,
      startsAt: SETEMBRO,
      endsAt: OUTUBRO,
      drawAt: null,
      prizes: [{ position: 1, title: "Cesta" }],
    });

    expect(raffle.sequence).toBe(1);
    expect(
      await db.raffleEntry.count({ where: { raffleId: raffle.id, donationId: pendente.id } }),
    ).toBe(4);
  });

  it("sequência é atribuída pelo servidor e a janela sobreposta é recusada", async () => {
    const { campaign } = await seedCampaign();
    const repo = createRafflesRepository(db);
    const um = await repo.create({
      campaignId: campaign.id,
      title: "Agosto",
      centsPerNumber: 1000,
      startsAt: AGOSTO,
      endsAt: SETEMBRO,
      drawAt: null,
      prizes: [{ position: 1, title: "Cesta" }],
    });
    const dois = await repo.create({
      campaignId: campaign.id,
      title: "Setembro",
      centsPerNumber: 1000,
      startsAt: SETEMBRO,
      endsAt: OUTUBRO,
      drawAt: null,
      prizes: [{ position: 1, title: "Camiseta" }],
    });
    expect([um.sequence, dois.sequence]).toEqual([1, 2]);

    await expect(
      repo.create({
        campaignId: campaign.id,
        title: "Sobreposto",
        centsPerNumber: 1000,
        startsAt: new Date("2026-09-15T03:00:00Z"),
        endsAt: new Date("2026-10-15T03:00:00Z"),
        drawAt: null,
        prizes: [{ position: 1, title: "X" }],
      }),
    ).rejects.toMatchObject({ message: "raffle_window_overlap" });
  });

  it("segundo sorteio sem fim é recusado enquanto o corrente não fecha a janela", async () => {
    const { campaign } = await seedCampaign();
    const repo = createRafflesRepository(db);
    await repo.create({
      campaignId: campaign.id,
      title: "Corrente",
      centsPerNumber: 1000,
      startsAt: AGOSTO,
      endsAt: null,
      drawAt: null,
      prizes: [{ position: 1, title: "Cesta" }],
    });

    await expect(
      repo.create({
        campaignId: campaign.id,
        title: "Próximo",
        centsPerNumber: 1000,
        startsAt: SETEMBRO,
        endsAt: null,
        drawAt: null,
        prizes: [{ position: 1, title: "X" }],
      }),
    ).rejects.toMatchObject({ message: "raffle_open_ended_conflict" });
  });

  it("sortear fecha a janela do sorteio sem fim, liberando o próximo", async () => {
    const { store, campaign, donor } = await seedCampaign();
    const corrente = await seedRaffle({
      campaignId: campaign.id,
      sequence: 1,
      startsAt: AGOSTO,
      endsAt: null,
    });
    await db.rafflePrize.create({
      data: { raffleId: corrente.id, position: 1, title: "Cesta" },
    });
    const donation = await seedPaidDonation({
      storeId: store.id,
      campaignId: campaign.id,
      userId: donor.id,
      paidAt: new Date("2026-08-10T12:00:00Z"),
    });
    const repo = createRafflesRepository(db);
    await repo.grantNumbersForDonation(donation.id, app.log);

    const drawn = await repo.draw(corrente.id, "seed-de-teste");
    // Sorteio realizado não recebe mais doação: a janela aberta virou fechada no draw.
    expect(drawn.endsAt).not.toBeNull();

    // ...e por isso o sorteio seguinte não colide mais.
    const proximo = await repo.create({
      campaignId: campaign.id,
      title: "Setembro",
      centsPerNumber: 1000,
      startsAt: SETEMBRO,
      endsAt: null,
      drawAt: null,
      prizes: [{ position: 1, title: "Camiseta" }],
    });
    expect(proximo.sequence).toBe(2);
  });

  it("doação paga depois do sorteio realizado concorre ao seguinte", async () => {
    const { store, campaign, donor } = await seedCampaign();
    const corrente = await seedRaffle({
      campaignId: campaign.id,
      sequence: 1,
      startsAt: AGOSTO,
      endsAt: null,
      status: "drawn",
    });
    // Janela fechada no momento do sorteio, como o draw passa a gravar.
    await db.raffle.update({
      where: { id: corrente.id },
      data: { drawnAt: SETEMBRO, endsAt: SETEMBRO },
    });
    const proximo = await seedRaffle({
      campaignId: campaign.id,
      sequence: 2,
      startsAt: SETEMBRO,
      endsAt: null,
    });
    const donation = await seedPaidDonation({
      storeId: store.id,
      campaignId: campaign.id,
      userId: donor.id,
      paidAt: new Date("2026-09-05T12:00:00Z"),
      amountCents: 2000,
    });

    const granted = await createRafflesRepository(db).grantNumbersForDonation(donation.id, app.log);

    expect(granted).toBe(2);
    expect(await db.raffleEntry.count({ where: { raffleId: proximo.id } })).toBe(2);
  });

  it("cancelar apaga os números, devolve as doações e zera a numeração", async () => {
    const { store, campaign, donor } = await seedCampaign();
    const corrente = await seedRaffle({
      campaignId: campaign.id,
      sequence: 1,
      startsAt: AGOSTO,
      endsAt: SETEMBRO,
    });
    const donation = await seedPaidDonation({
      storeId: store.id,
      campaignId: campaign.id,
      userId: donor.id,
      paidAt: new Date("2026-08-10T12:00:00Z"),
      amountCents: 3000,
    });
    const repo = createRafflesRepository(db);
    expect(await repo.grantNumbersForDonation(donation.id, app.log)).toBe(3);

    const cancelled = await repo.setStatus(corrente.id, "cancelled");

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.nextNumber).toBe(1);
    expect(await db.raffleEntry.count({ where: { raffleId: corrente.id } })).toBe(0);
    expect(
      (await db.donation.findUniqueOrThrow({ where: { id: donation.id } })).raffleGranted,
    ).toBe(false);
  });

  it("sorteio cancelado não captura doação: ela concorre ao próximo da janela", async () => {
    const { store, campaign, donor } = await seedCampaign();
    const cancelado = await seedRaffle({
      campaignId: campaign.id,
      sequence: 1,
      startsAt: AGOSTO,
      endsAt: SETEMBRO,
    });
    const repo = createRafflesRepository(db);
    await repo.setStatus(cancelado.id, "cancelled");
    // substituto ocupa a MESMA janela do cancelado
    const substituto = await repo.create({
      campaignId: campaign.id,
      title: "Agosto de novo",
      centsPerNumber: 1000,
      startsAt: AGOSTO,
      endsAt: SETEMBRO,
      drawAt: null,
      prizes: [{ position: 1, title: "Cesta" }],
    });
    const donation = await seedPaidDonation({
      storeId: store.id,
      campaignId: campaign.id,
      userId: donor.id,
      paidAt: new Date("2026-08-10T12:00:00Z"),
      amountCents: 2000,
    });

    const granted = await repo.grantNumbersForDonation(donation.id, app.log);

    expect(granted).toBe(2);
    expect(await db.raffleEntry.count({ where: { raffleId: substituto.id } })).toBe(2);
    expect(await db.raffleEntry.count({ where: { raffleId: cancelado.id } })).toBe(0);
  });

  it("reabrir devolve os números de quem doou na janela", async () => {
    const { store, campaign, donor } = await seedCampaign();
    const raffle = await seedRaffle({
      campaignId: campaign.id,
      sequence: 1,
      startsAt: AGOSTO,
      endsAt: SETEMBRO,
    });
    const donation = await seedPaidDonation({
      storeId: store.id,
      campaignId: campaign.id,
      userId: donor.id,
      paidAt: new Date("2026-08-10T12:00:00Z"),
      amountCents: 3000,
    });
    const repo = createRafflesRepository(db);
    await repo.grantNumbersForDonation(donation.id, app.log);
    await repo.setStatus(raffle.id, "cancelled");

    const reaberto = await repo.setStatus(raffle.id, "open");

    expect(reaberto.status).toBe("open");
    // backfill: a doação da janela volta a ter números, numerados do 1
    const numeros = await db.raffleEntry.findMany({
      where: { raffleId: raffle.id },
      select: { number: true },
      orderBy: { number: "asc" },
    });
    expect(numeros.map((n) => n.number)).toEqual([1, 2, 3]);
  });

  it("reabrir com a janela já ocupada por outro sorteio → 409", async () => {
    const { campaign } = await seedCampaign();
    const repo = createRafflesRepository(db);
    const original = await seedRaffle({
      campaignId: campaign.id,
      sequence: 1,
      startsAt: AGOSTO,
      endsAt: SETEMBRO,
    });
    await repo.setStatus(original.id, "cancelled");
    await repo.create({
      campaignId: campaign.id,
      title: "Substituto",
      centsPerNumber: 1000,
      startsAt: AGOSTO,
      endsAt: SETEMBRO,
      drawAt: null,
      prizes: [{ position: 1, title: "Cesta" }],
    });

    await expect(repo.setStatus(original.id, "open")).rejects.toMatchObject({
      message: "raffle_window_overlap",
    });
  });

  it("sorteio realizado não cancela nem reabre", async () => {
    const { campaign } = await seedCampaign();
    const drawn = await seedRaffle({
      campaignId: campaign.id,
      sequence: 1,
      startsAt: AGOSTO,
      endsAt: SETEMBRO,
      status: "drawn",
    });
    const repo = createRafflesRepository(db);

    await expect(repo.setStatus(drawn.id, "cancelled")).rejects.toMatchObject({
      message: "invalid_raffle_transition",
    });
    await expect(repo.setStatus(drawn.id, "open")).rejects.toMatchObject({
      message: "invalid_raffle_transition",
    });
  });

  it("doação sem paidAt (histórico) cai na janela pelo createdAt", async () => {
    const { store, campaign, donor } = await seedCampaign();
    const corrente = await seedRaffle({
      campaignId: campaign.id,
      sequence: 1,
      startsAt: new Date("2020-01-01T00:00:00Z"),
      endsAt: null,
    });
    const donation = await db.donation.create({
      data: {
        storeId: store.id,
        campaignId: campaign.id,
        userId: donor.id,
        type: "one_time",
        amountCents: 3000,
        status: "paid",
      },
    });

    const granted = await createRafflesRepository(db).grantNumbersForDonation(donation.id, app.log);

    expect(granted).toBe(3);
    expect(await db.raffleEntry.count({ where: { raffleId: corrente.id } })).toBe(3);
  });
});
