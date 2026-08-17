import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/infra/db/client.js";
import { logger } from "../../src/infra/observability/logger.js";
import { expireDonations } from "../../src/workers/expire-donations.js";
import { expireReservations } from "../../src/workers/expire-reservations.js";
import { relayOutbox } from "../../src/workers/outbox-relay.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

async function seed(expiresAt: Date) {
  const user = await db.user.create({
    data: { email: "w@example.org", name: "Cliente", passwordHash: "x" },
  });
  const store = await db.store.create({
    data: { slug: "nucleo-a", name: "Núcleo A", status: "active" },
  });
  const product = await db.product.create({
    data: { storeId: store.id, slug: "mel", name: "Mel", priceCents: 2500, stock: 8 },
  });
  const order = await db.order.create({
    data: {
      storeId: store.id,
      userId: user.id,
      totalCents: 5000,
      contactPhone: "11999990000",
      expiresAt,
      items: { create: [{ productId: product.id, name: "Mel", priceCents: 2500, qty: 2 }] },
      payment: { create: { provider: "woovi", amountCents: 5000, applicationFeeCents: 250 } },
    },
  });
  return { user, order, product };
}

describe("workers", () => {
  beforeEach(resetDb);

  it("expireReservations cancela pedido vencido e devolve estoque", async () => {
    const { order, product } = await seed(new Date(Date.now() - 60_000));
    const n = await expireReservations({ db });
    expect(n).toBe(1);
    const fresh = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("cancelled");
    const payment = await db.payment.findFirstOrThrow({ where: { orderId: order.id } });
    expect(payment.status).toBe("expired");
    const restocked = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(restocked.stock).toBe(10);
  });

  it("expireReservations ignora pedido dentro do prazo", async () => {
    await seed(new Date(Date.now() + 60_000));
    expect(await expireReservations({ db })).toBe(0);
  });

  it("relayOutbox envia email de confirmação para order.paid e marca processed", async () => {
    const { order, user } = await seed(new Date(Date.now() + 60_000));
    await db.order.update({ where: { id: order.id }, data: { status: "paid" } });
    await db.outboxEvent.create({ data: { type: "order.paid", payload: { orderId: order.id } } });
    const gateways = buildFakeGateways();
    const n = await relayOutbox({ db, email: gateways.email, log: logger });
    expect(n).toBe(1);
    expect(gateways.sentEmails).toHaveLength(1);
    expect(gateways.sentEmails[0]?.to).toBe(user.email);
    expect(gateways.sentEmails[0]?.subject).toContain("Pagamento confirmado");
    const event = await db.outboxEvent.findFirstOrThrow();
    expect(event.status).toBe("processed");
  });

  it("relayOutbox: erro incrementa attempts e marca failed após 5", async () => {
    const { order } = await seed(new Date(Date.now() + 60_000));
    await db.outboxEvent.create({
      data: { type: "order.paid", payload: { orderId: order.id }, attempts: 4 },
    });
    const gateways = buildFakeGateways({
      email: {
        async send() {
          throw new Error("smtp down");
        },
      },
    });
    await relayOutbox({ db, email: gateways.email, log: logger });
    const event = await db.outboxEvent.findFirstOrThrow();
    expect(event.attempts).toBe(5);
    expect(event.status).toBe("failed");
  });

  it("relayOutbox reclama registro 'processing' com claimedAt velho (crash anterior) e envia o email uma única vez", async () => {
    const { order, user } = await seed(new Date(Date.now() + 60_000));
    await db.order.update({ where: { id: order.id }, data: { status: "paid" } });
    const event = await db.outboxEvent.create({
      data: {
        type: "order.paid",
        payload: { orderId: order.id },
        status: "processing",
        claimedBy: "stale-worker-token",
        claimedAt: new Date(Date.now() - 6 * 60_000),
      },
    });
    const gateways = buildFakeGateways();
    const n = await relayOutbox({ db, email: gateways.email, log: logger });
    expect(n).toBe(1);
    expect(gateways.sentEmails).toHaveLength(1);
    expect(gateways.sentEmails[0]?.to).toBe(user.email);
    const fresh = await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(fresh.status).toBe("processed");
    expect(fresh.claimedBy).toBeNull();
  });

  it("relayOutbox não toca registro 'processing' reivindicado por outro token com claimedAt recente", async () => {
    const { order } = await seed(new Date(Date.now() + 60_000));
    await db.order.update({ where: { id: order.id }, data: { status: "paid" } });
    const event = await db.outboxEvent.create({
      data: {
        type: "order.paid",
        payload: { orderId: order.id },
        status: "processing",
        claimedBy: "other-instance-token",
        claimedAt: new Date(),
      },
    });
    const gateways = buildFakeGateways();
    const n = await relayOutbox({ db, email: gateways.email, log: logger });
    expect(n).toBe(0);
    expect(gateways.sentEmails).toHaveLength(0);
    const fresh = await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(fresh.status).toBe("processing");
    expect(fresh.claimedBy).toBe("other-instance-token");
  });

  it("interest.notified vira email para quem encomendou", async () => {
    const store = await db.store.create({
      data: { slug: "nucleo-a", name: "Núcleo A", status: "active" },
    });
    const product = await db.product.create({
      data: {
        storeId: store.id,
        slug: "cha-especial",
        name: "Chá especial",
        priceCents: 5000,
        availability: "on_demand",
      },
    });
    const user = await db.user.create({
      data: { email: "encomenda@example.org", name: "Cliente", passwordHash: "x" },
    });
    const interest = await db.productInterest.create({
      data: {
        productId: product.id,
        userId: user.id,
        qty: 2,
        status: "notified",
        notifiedAt: new Date(),
      },
    });
    await db.outboxEvent.create({
      data: { type: "interest.notified", payload: { interestId: interest.id } },
    });

    const gateways = buildFakeGateways();
    const processed = await relayOutbox({ db, email: gateways.email, log: logger });

    expect(processed).toBe(1);
    expect(gateways.sentEmails).toHaveLength(1);
    expect(gateways.sentEmails[0]?.to).toBe("encomenda@example.org");
    expect(gateways.sentEmails[0]?.subject).toContain("Chá especial");
    const row = await db.outboxEvent.findFirstOrThrow({ where: { type: "interest.notified" } });
    expect(row.status).toBe("processed");
  });

  it("interest.notified não envia email se o interesse não está mais 'notified'", async () => {
    const store = await db.store.create({
      data: { slug: "nucleo-a", name: "Núcleo A", status: "active" },
    });
    const product = await db.product.create({
      data: {
        storeId: store.id,
        slug: "cha-especial",
        name: "Chá especial",
        priceCents: 5000,
        availability: "on_demand",
      },
    });
    const user = await db.user.create({
      data: { email: "cancelou@example.org", name: "Cliente", passwordHash: "x" },
    });
    // Cliente cancelou entre o enfileiramento do evento e este tick.
    const interest = await db.productInterest.create({
      data: {
        productId: product.id,
        userId: user.id,
        qty: 2,
        status: "cancelled",
      },
    });
    await db.outboxEvent.create({
      data: { type: "interest.notified", payload: { interestId: interest.id } },
    });

    const gateways = buildFakeGateways();
    const processed = await relayOutbox({ db, email: gateways.email, log: logger });

    expect(processed).toBe(1);
    expect(gateways.sentEmails).toHaveLength(0);
    const row = await db.outboxEvent.findFirstOrThrow({ where: { type: "interest.notified" } });
    expect(row.status).toBe("processed");
  });

  it("order.paid converte os interesses do comprador nos produtos do pedido", async () => {
    const store = await db.store.create({
      data: { slug: "nucleo-a", name: "Núcleo A", status: "active" },
    });
    const product = await db.product.create({
      data: {
        storeId: store.id,
        slug: "cha-especial",
        name: "Chá especial",
        priceCents: 5000,
        availability: "on_demand",
      },
    });
    // Segundo produto do mesmo pedido, para cobrir a transição open → converted
    // diretamente (interesse que nunca foi notificado, convertido pelo order.paid).
    const product2 = await db.product.create({
      data: {
        storeId: store.id,
        slug: "outro-produto",
        name: "Outro produto",
        priceCents: 3000,
        availability: "on_demand",
      },
    });
    const buyer = await db.user.create({
      data: { email: "comprador@example.org", name: "Comprador", passwordHash: "x" },
    });
    const outro = await db.user.create({
      data: { email: "outro@example.org", name: "Outro", passwordHash: "x" },
    });
    const mine = await db.productInterest.create({
      data: { productId: product.id, userId: buyer.id, qty: 1, status: "notified" },
    });
    const mineOpen = await db.productInterest.create({
      data: { productId: product2.id, userId: buyer.id, qty: 1 },
    });
    const alheio = await db.productInterest.create({
      data: { productId: product.id, userId: outro.id, qty: 1 },
    });
    const order = await db.order.create({
      data: {
        storeId: store.id,
        userId: buyer.id,
        status: "paid",
        totalCents: 8000,
        contactPhone: "11999990000",
        expiresAt: new Date(Date.now() + 60_000),
        items: {
          create: [
            { productId: product.id, name: "Chá especial", priceCents: 5000, qty: 1 },
            { productId: product2.id, name: "Outro produto", priceCents: 3000, qty: 1 },
          ],
        },
      },
    });
    await db.outboxEvent.create({ data: { type: "order.paid", payload: { orderId: order.id } } });

    const gateways = buildFakeGateways();
    await relayOutbox({ db, email: gateways.email, log: logger });

    expect((await db.productInterest.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe(
      "converted",
    );
    // open → converted direto, sem passar por notified: o caso mais comum de conversão.
    expect(
      (await db.productInterest.findUniqueOrThrow({ where: { id: mineOpen.id } })).status,
    ).toBe("converted");
    // Interesse de outra pessoa no mesmo produto continua na fila.
    expect((await db.productInterest.findUniqueOrThrow({ where: { id: alheio.id } })).status).toBe(
      "open",
    );
  });

  it("conversão não reabre interesse cancelado", async () => {
    const store = await db.store.create({
      data: { slug: "nucleo-a", name: "Núcleo A", status: "active" },
    });
    const product = await db.product.create({
      data: {
        storeId: store.id,
        slug: "cha-especial",
        name: "Chá especial",
        priceCents: 5000,
        availability: "on_demand",
      },
    });
    const buyer = await db.user.create({
      data: { email: "comprador2@example.org", name: "Comprador", passwordHash: "x" },
    });
    const cancelled = await db.productInterest.create({
      data: { productId: product.id, userId: buyer.id, qty: 1, status: "cancelled" },
    });
    const order = await db.order.create({
      data: {
        storeId: store.id,
        userId: buyer.id,
        status: "paid",
        totalCents: 5000,
        contactPhone: "11999990000",
        expiresAt: new Date(Date.now() + 60_000),
        items: {
          create: [{ productId: product.id, name: "Chá especial", priceCents: 5000, qty: 1 }],
        },
      },
    });
    await db.outboxEvent.create({ data: { type: "order.paid", payload: { orderId: order.id } } });

    const gateways = buildFakeGateways();
    await relayOutbox({ db, email: gateways.email, log: logger });

    expect(
      (await db.productInterest.findUniqueOrThrow({ where: { id: cancelled.id } })).status,
    ).toBe("cancelled");
  });
});

async function seedDonation(
  expiresAt: Date | null,
  status: "pending_payment" | "paid" | "refunded" = "pending_payment",
) {
  const user = await db.user.create({
    data: { email: "doador@example.org", name: "Doadora", passwordHash: "x" },
  });
  const store = await db.store.create({
    data: { slug: "nucleo-a", name: "Núcleo A", status: "active" },
  });
  const donation = await db.donation.create({
    data: {
      storeId: store.id,
      userId: user.id,
      amountCents: 5000,
      status,
      expiresAt,
      payment: { create: { provider: "woovi", amountCents: 5000, applicationFeeCents: 250 } },
    },
  });
  return { user, store, donation };
}

describe("expireDonations", () => {
  beforeEach(resetDb);

  it("cancela doação vencida e marca o pagamento expired; é no-op na segunda chamada", async () => {
    const { donation } = await seedDonation(new Date(Date.now() - 60_000));
    const n = await expireDonations({ db });
    expect(n).toBe(1);
    const fresh = await db.donation.findUniqueOrThrow({ where: { id: donation.id } });
    expect(fresh.status).toBe("cancelled");
    const payment = await db.payment.findFirstOrThrow({ where: { donationId: donation.id } });
    expect(payment.status).toBe("expired");

    const second = await expireDonations({ db });
    expect(second).toBe(0);
  });

  it("ignora doação dentro do prazo", async () => {
    await seedDonation(new Date(Date.now() + 60_000));
    expect(await expireDonations({ db })).toBe(0);
  });
});

describe("relayOutbox: doação", () => {
  beforeEach(resetDb);

  it("processa donation.received e manda exatamente um email para o doador", async () => {
    const { user, donation } = await seedDonation(null, "paid");
    await db.outboxEvent.create({
      data: { type: "donation.received", payload: { donationId: donation.id } },
    });
    const gateways = buildFakeGateways();
    const n = await relayOutbox({ db, email: gateways.email, log: logger });
    expect(n).toBe(1);
    expect(gateways.sentEmails).toHaveLength(1);
    expect(gateways.sentEmails[0]?.to).toBe(user.email);
    expect(gateways.sentEmails[0]?.subject).toContain("Recebemos sua doação");
    const event = await db.outboxEvent.findFirstOrThrow();
    expect(event.status).toBe("processed");
  });

  it("ignora donation.received de doação que não está mais paid, mas ainda marca o evento como processed", async () => {
    const { donation } = await seedDonation(null, "refunded");
    await db.outboxEvent.create({
      data: { type: "donation.received", payload: { donationId: donation.id } },
    });
    const gateways = buildFakeGateways();
    const n = await relayOutbox({ db, email: gateways.email, log: logger });
    expect(n).toBe(1);
    expect(gateways.sentEmails).toHaveLength(0);
    const event = await db.outboxEvent.findFirstOrThrow();
    expect(event.status).toBe("processed");
  });
});

async function seedCampaignDonation(amountCents: number, opts?: { withRaffle?: boolean }) {
  const user = await db.user.create({
    data: { email: `doador-${Math.random()}@example.org`, name: "Doadora", passwordHash: "x" },
  });
  const store = await db.store.create({
    data: {
      slug: `nucleo-${Math.random().toString(36).slice(2)}`,
      name: "Núcleo A",
      status: "active",
    },
  });
  const campaign = await db.campaign.create({
    data: { storeId: store.id, slug: "reforma", title: "Reforma", status: "active" },
  });
  if (opts?.withRaffle ?? true) {
    await db.raffle.create({ data: { campaignId: campaign.id, centsPerNumber: 5000 } });
  }
  const donation = await db.donation.create({
    data: {
      storeId: store.id,
      campaignId: campaign.id,
      userId: user.id,
      amountCents,
      status: "paid",
    },
  });
  return { user, store, campaign, donation };
}

describe("relayOutbox: concessão de números do sorteio", () => {
  beforeEach(resetDb);

  it("doação de R$ 100 com centsPerNumber 5000 gera 2 números consecutivos a partir de 1 e marca raffleGranted", async () => {
    const { donation } = await seedCampaignDonation(10_000);
    await db.outboxEvent.create({
      data: { type: "donation.received", payload: { donationId: donation.id } },
    });
    const gateways = buildFakeGateways();
    await relayOutbox({ db, email: gateways.email, log: logger });

    const entries = await db.raffleEntry.findMany({
      where: { donationId: donation.id },
      orderBy: { number: "asc" },
    });
    expect(entries.map((e) => e.number)).toEqual([1, 2]);
    const fresh = await db.donation.findUniqueOrThrow({ where: { id: donation.id } });
    expect(fresh.raffleGranted).toBe(true);
  });

  it("reprocessar o mesmo donation.received não gera número novo", async () => {
    const { donation } = await seedCampaignDonation(10_000);
    await db.outboxEvent.create({
      data: { type: "donation.received", payload: { donationId: donation.id } },
    });
    const gateways = buildFakeGateways();
    await relayOutbox({ db, email: gateways.email, log: logger });

    // Reenfileira o mesmo evento à mão e roda o relay de novo.
    await db.outboxEvent.create({
      data: { type: "donation.received", payload: { donationId: donation.id } },
    });
    await relayOutbox({ db, email: gateways.email, log: logger });

    const entries = await db.raffleEntry.findMany({ where: { donationId: donation.id } });
    expect(entries).toHaveLength(2);
  });

  it("duas doações geram faixas disjuntas (1–2 e 3–4)", async () => {
    const { campaign, store, donation: donation1 } = await seedCampaignDonation(10_000);
    const donor2 = await db.user.create({
      data: { email: "doadora2@example.org", name: "Doadora 2", passwordHash: "x" },
    });
    const donation2 = await db.donation.create({
      data: {
        storeId: store.id,
        campaignId: campaign.id,
        userId: donor2.id,
        amountCents: 10_000,
        status: "paid",
      },
    });
    await db.outboxEvent.create({
      data: { type: "donation.received", payload: { donationId: donation1.id } },
    });
    await db.outboxEvent.create({
      data: { type: "donation.received", payload: { donationId: donation2.id } },
    });
    const gateways = buildFakeGateways();
    await relayOutbox({ db, email: gateways.email, log: logger });

    const entries1 = await db.raffleEntry.findMany({
      where: { donationId: donation1.id },
      orderBy: { number: "asc" },
    });
    const entries2 = await db.raffleEntry.findMany({
      where: { donationId: donation2.id },
      orderBy: { number: "asc" },
    });
    expect(entries1.map((e) => e.number)).toEqual([1, 2]);
    expect(entries2.map((e) => e.number)).toEqual([3, 4]);
  });

  it("doação avulsa (sem campanha) e doação em campanha sem sorteio não geram nada", async () => {
    const { donation: comSorteio } = await seedCampaignDonation(10_000, { withRaffle: false });
    const { donation } = await seedDonation(null, "paid");
    await db.outboxEvent.create({
      data: { type: "donation.received", payload: { donationId: donation.id } },
    });
    await db.outboxEvent.create({
      data: { type: "donation.received", payload: { donationId: comSorteio.id } },
    });
    const gateways = buildFakeGateways();
    await relayOutbox({ db, email: gateways.email, log: logger });

    expect(await db.raffleEntry.count()).toBe(0);
  });

  it("doação de R$ 10 com centsPerNumber 5000 gera zero números e ainda manda o email de agradecimento", async () => {
    const { donation, user } = await seedCampaignDonation(1_000);
    await db.outboxEvent.create({
      data: { type: "donation.received", payload: { donationId: donation.id } },
    });
    const gateways = buildFakeGateways();
    await relayOutbox({ db, email: gateways.email, log: logger });

    expect(await db.raffleEntry.count({ where: { donationId: donation.id } })).toBe(0);
    expect(gateways.sentEmails).toHaveLength(1);
    expect(gateways.sentEmails[0]?.to).toBe(user.email);
  });
});
