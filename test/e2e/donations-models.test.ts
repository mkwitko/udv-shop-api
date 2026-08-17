import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";

async function seed() {
  const store = await db.store.create({
    data: { slug: "nucleo-a", name: "Núcleo A", status: "active" },
  });
  const user = await db.user.create({
    data: { email: "doador@example.org", name: "Maria Silva", passwordHash: "x" },
  });
  const campaign = await db.campaign.create({
    data: {
      storeId: store.id,
      slug: "reforma-do-salao",
      title: "Reforma do salão",
      goalCents: 500_000,
      status: "active",
    },
  });
  return { store, user, campaign };
}

describe("modelos de doação", () => {
  afterAll(() => db.$disconnect());
  beforeEach(resetDb);

  it("campanha é única por (loja, slug)", async () => {
    const { store } = await seed();
    await expect(
      db.campaign.create({
        data: { storeId: store.id, slug: "reforma-do-salao", title: "Outra" },
      }),
    ).rejects.toThrow();
  });

  it("doação avulsa (sem campanha) é válida", async () => {
    const { store, user } = await seed();
    const donation = await db.donation.create({
      data: { storeId: store.id, userId: user.id, amountCents: 5000 },
    });
    expect(donation.campaignId).toBeNull();
    expect(donation.status).toBe("pending_payment");
    expect(donation.type).toBe("one_time");
    expect(donation.anonymous).toBe(false);
    expect(donation.raffleGranted).toBe(false);
  });

  it("pagamento aponta para doação e é único por doação", async () => {
    const { store, user, campaign } = await seed();
    const donation = await db.donation.create({
      data: { storeId: store.id, campaignId: campaign.id, userId: user.id, amountCents: 10_000 },
    });
    await db.payment.create({
      data: {
        donationId: donation.id,
        provider: "stripe",
        amountCents: 10_000,
        applicationFeeCents: 500,
      },
    });
    await expect(
      db.payment.create({
        data: {
          donationId: donation.id,
          provider: "stripe",
          amountCents: 10_000,
          applicationFeeCents: 500,
        },
      }),
    ).rejects.toThrow();
  });

  it("invoice de assinatura é único (idempotência do ciclo mensal)", async () => {
    const { store, user } = await seed();
    await db.donation.create({
      data: {
        storeId: store.id,
        userId: user.id,
        amountCents: 3000,
        type: "monthly",
        subscriptionRef: "sub_1",
        providerInvoiceId: "in_1",
      },
    });
    await expect(
      db.donation.create({
        data: {
          storeId: store.id,
          userId: user.id,
          amountCents: 3000,
          type: "monthly",
          subscriptionRef: "sub_1",
          providerInvoiceId: "in_1",
        },
      }),
    ).rejects.toThrow();
  });

  it("sorteio é 1:1 com campanha e número é único dentro do sorteio", async () => {
    const { store, user, campaign } = await seed();
    const raffle = await db.raffle.create({
      data: { campaignId: campaign.id, centsPerNumber: 5000 },
    });
    expect(raffle.status).toBe("open");
    expect(raffle.nextNumber).toBe(1);
    expect(raffle.algorithm).toBe("sha256-counter-v1");
    await expect(
      db.raffle.create({ data: { campaignId: campaign.id, centsPerNumber: 1000 } }),
    ).rejects.toThrow();

    const donation = await db.donation.create({
      data: {
        storeId: store.id,
        campaignId: campaign.id,
        userId: user.id,
        amountCents: 10_000,
        status: "paid",
      },
    });
    await db.raffleEntry.create({
      data: { raffleId: raffle.id, donationId: donation.id, userId: user.id, number: 1 },
    });
    await expect(
      db.raffleEntry.create({
        data: { raffleId: raffle.id, donationId: donation.id, userId: user.id, number: 1 },
      }),
    ).rejects.toThrow();
  });

  it("prêmio é único por posição e aponta para a entrada vencedora", async () => {
    const { store, user, campaign } = await seed();
    const raffle = await db.raffle.create({
      data: { campaignId: campaign.id, centsPerNumber: 5000 },
    });
    const donation = await db.donation.create({
      data: {
        storeId: store.id,
        campaignId: campaign.id,
        userId: user.id,
        amountCents: 10_000,
        status: "paid",
      },
    });
    const entry = await db.raffleEntry.create({
      data: { raffleId: raffle.id, donationId: donation.id, userId: user.id, number: 7 },
    });
    await db.rafflePrize.create({
      data: { raffleId: raffle.id, position: 1, title: "Cesta", winnerEntryId: entry.id },
    });
    await expect(
      db.rafflePrize.create({ data: { raffleId: raffle.id, position: 1, title: "Outro" } }),
    ).rejects.toThrow();
    const loaded = await db.rafflePrize.findFirstOrThrow({
      where: { raffleId: raffle.id },
      include: { winnerEntry: true },
    });
    expect(loaded.winnerEntry?.number).toBe(7);
  });
});
