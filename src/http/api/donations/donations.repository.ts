import type { DonationStatus, PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  afterCursorWhere,
  type CursorPage,
  decodeCursor,
  KEYSET_ORDER_BY,
  toPage,
} from "../../../lib/cursor.js";

const DONATION_INCLUDE = {
  store: { select: { slug: true, name: true } },
  campaign: { select: { slug: true, title: true } },
  payment: { select: { id: true, provider: true, status: true } },
  entries: { select: { number: true }, orderBy: { number: "asc" } },
} satisfies Prisma.DonationInclude;

export type DonationWithDetails = Prisma.DonationGetPayload<{ include: typeof DONATION_INCLUDE }>;

const DONOR_INCLUDE = {
  ...DONATION_INCLUDE,
  user: { select: { name: true, email: true, phone: true } },
} satisfies Prisma.DonationInclude;

export type DonationWithDonor = Prisma.DonationGetPayload<{ include: typeof DONOR_INCLUDE }>;

export interface DonationsRepository {
  createPendingDonation(input: {
    storeId: string;
    campaignId: string | null;
    userId: string;
    provider: "stripe" | "woovi";
    type: "one_time" | "monthly";
    amountCents: number;
    applicationFeeCents: number;
    anonymous: boolean;
    message: string | null;
    expiresAt: Date | null;
  }): Promise<DonationWithDetails>;
  attachProviderId(paymentId: string, providerId: string): Promise<void>;
  attachSubscriptionRef(donationId: string, subscriptionRef: string): Promise<void>;
  compensateFailedDonation(donationId: string): Promise<void>;
  markPaid(
    paymentId: string,
    providerId: string | null,
  ): Promise<{ donationId: string; donationWasPending: boolean } | null>;
  cancelPendingDonation(
    donationId: string,
    paymentStatus: "expired" | "failed" | "cancelled",
  ): Promise<boolean>;
  markRefundedByPaymentId(paymentId: string): Promise<boolean>;
  listExpiredPending(now: Date): Promise<Array<{ id: string }>>;
  findByIdForUser(id: string, userId: string): Promise<DonationWithDetails | null>;
  listMineCursor(args: {
    userId: string;
    status: DonationStatus | null;
    limit: number;
    cursor: string | null;
  }): Promise<CursorPage<DonationWithDetails>>;
  listByStoreCursor(args: {
    storeId: string;
    campaignId: string | null;
    status: DonationStatus | null;
    limit: number;
    cursor: string | null;
  }): Promise<CursorPage<DonationWithDonor>>;
  markSubscriptionInvoicePaid(input: {
    subscriptionRef: string;
    invoiceId: string;
    amountCents: number;
  }): Promise<{ donationId: string; created: boolean } | null>;
  markSubscriptionCancelled(subscriptionRef: string): Promise<boolean>;
  /**
   * Assinatura de doação e assinatura SaaS da loja agora vivem as duas na conta da
   * plataforma e compartilham os mesmos tipos de evento. Este lookup é o que separa uma
   * da outra no webhook — ver ADR-025.
   */
  isDonationSubscription(subscriptionRef: string): Promise<boolean>;
}

export function createDonationsRepository(db: PrismaClient): DonationsRepository {
  return {
    createPendingDonation: (input) =>
      db.donation.create({
        data: {
          storeId: input.storeId,
          campaignId: input.campaignId,
          userId: input.userId,
          type: input.type,
          amountCents: input.amountCents,
          anonymous: input.anonymous,
          message: input.message,
          expiresAt: input.expiresAt,
          payment: {
            create: {
              provider: input.provider,
              amountCents: input.amountCents,
              applicationFeeCents: input.applicationFeeCents,
            },
          },
        },
        include: DONATION_INCLUDE,
      }),

    attachProviderId: async (paymentId, providerId) => {
      await db.payment.update({ where: { id: paymentId }, data: { providerId } });
    },

    attachSubscriptionRef: async (donationId, subscriptionRef) => {
      await db.donation.update({ where: { id: donationId }, data: { subscriptionRef } });
    },

    compensateFailedDonation: async (donationId) => {
      await db.$transaction(async (tx) => {
        const cancelled = await tx.donation.updateMany({
          where: { id: donationId, status: "pending_payment" },
          data: { status: "cancelled" },
        });
        if (cancelled.count !== 1) return;
        await tx.payment.updateMany({
          where: { donationId, status: "pending" },
          data: { status: "failed" },
        });
      });
    },

    markPaid: (paymentId, providerId) =>
      db.$transaction(async (tx) => {
        // Mesma janela larga de markPaid do plano 3 (ADR-012): o provedor pode confirmar
        // depois do nosso TTL ter marcado expired/failed/cancelled.
        const paid = await tx.payment.updateMany({
          where: { id: paymentId, status: { in: ["pending", "expired", "failed", "cancelled"] } },
          data: { status: "succeeded", ...(providerId !== null && { providerId }) },
        });
        if (paid.count !== 1) return null;
        const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
        if (!payment.donationId) return null;
        const transitioned = await tx.donation.updateMany({
          where: { id: payment.donationId, status: "pending_payment" },
          data: { status: "paid" },
        });
        const donationWasPending = transitioned.count === 1;
        await tx.outboxEvent.create({
          data: donationWasPending
            ? { type: "donation.received", payload: { donationId: payment.donationId } }
            : {
                type: "payment.orphaned",
                payload: { donationId: payment.donationId, paymentId: payment.id },
              },
        });
        return { donationId: payment.donationId, donationWasPending };
      }),

    cancelPendingDonation: async (donationId, paymentStatus) =>
      db.$transaction(async (tx) => {
        const cancelled = await tx.donation.updateMany({
          where: { id: donationId, status: "pending_payment" },
          data: { status: "cancelled" },
        });
        if (cancelled.count !== 1) return false;
        await tx.payment.updateMany({
          where: { donationId, status: "pending" },
          data: { status: paymentStatus },
        });
        return true;
      }),

    markRefundedByPaymentId: (paymentId) =>
      db.$transaction(async (tx) => {
        const updated = await tx.payment.updateMany({
          where: { id: paymentId, status: { in: ["succeeded", "refund_pending"] } },
          data: { status: "refunded" },
        });
        if (updated.count !== 1) return false;
        const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
        if (payment.donationId) {
          const refunded = await tx.donation.updateMany({
            where: { id: payment.donationId, status: "paid" },
            data: { status: "refunded", raffleGranted: false },
          });
          // Dinheiro devolvido não concorre a prêmio: os números voltam para o sorteio.
          // Só enquanto ele está "open" — depois do draw, apagar entradas apagaria o
          // vencedor já registrado, e aí o caso é da gestão resolver fora do sistema.
          if (refunded.count === 1) {
            await tx.raffleEntry.deleteMany({
              where: { donationId: payment.donationId, raffle: { status: "open" } },
            });
          }
        }
        return true;
      }),

    listExpiredPending: (now) =>
      db.donation.findMany({
        where: { status: "pending_payment", expiresAt: { lt: now } },
        select: { id: true },
        take: 200,
      }),

    findByIdForUser: (id, userId) =>
      db.donation.findFirst({ where: { id, userId }, include: DONATION_INCLUDE }),

    listMineCursor: async ({ userId, status, limit, cursor }) => {
      const after = cursor ? afterCursorWhere(decodeCursor(cursor)) : {};
      const rows = await db.donation.findMany({
        where: { userId, ...(status !== null && { status }), ...after },
        orderBy: [...KEYSET_ORDER_BY],
        take: limit + 1,
        include: DONATION_INCLUDE,
      });
      return toPage(
        rows,
        limit,
        (r) => ({ createdAt: r.createdAt, id: r.id }),
        (r) => r,
      );
    },

    listByStoreCursor: async ({ storeId, campaignId, status, limit, cursor }) => {
      const after = cursor ? afterCursorWhere(decodeCursor(cursor)) : {};
      const rows = await db.donation.findMany({
        where: {
          storeId,
          ...(campaignId !== null && { campaignId }),
          ...(status !== null && { status }),
          ...after,
        },
        orderBy: [...KEYSET_ORDER_BY],
        take: limit + 1,
        include: DONOR_INCLUDE,
      });
      return toPage(
        rows,
        limit,
        (r) => ({ createdAt: r.createdAt, id: r.id }),
        (r) => r,
      );
    },

    markSubscriptionInvoicePaid: async ({ subscriptionRef, invoiceId, amountCents }) => {
      // Idempotência do ciclo: providerInvoiceId é @unique. Duas entregas do mesmo
      // invoice.paid (o Stripe reenvia) só podem produzir uma linha — ver D5.
      const already = await db.donation.findUnique({ where: { providerInvoiceId: invoiceId } });
      if (already) return null;
      // A âncora é a doação criada no POST /donations, a mais antiga do subscriptionRef.
      const anchor = await db.donation.findFirst({
        where: { subscriptionRef },
        orderBy: { createdAt: "asc" },
      });
      if (!anchor) return null;

      if (anchor.status === "pending_payment") {
        return db.$transaction(async (tx) => {
          const claimed = await tx.donation.updateMany({
            where: { id: anchor.id, status: "pending_payment" },
            data: { status: "paid", providerInvoiceId: invoiceId },
          });
          if (claimed.count !== 1) return null;
          await tx.payment.updateMany({
            where: { donationId: anchor.id, status: { in: ["pending", "failed", "expired"] } },
            data: { status: "succeeded", providerId: invoiceId },
          });
          await tx.outboxEvent.create({
            data: { type: "donation.received", payload: { donationId: anchor.id } },
          });
          return { donationId: anchor.id, created: false };
        });
      }

      // Ciclo seguinte: linha nova, para a meta da campanha e os números do sorteio
      // andarem todo mês.
      const store = await db.store.findUniqueOrThrow({
        where: { id: anchor.storeId },
        select: { applicationFeeBps: true },
      });
      const applicationFeeCents = Math.floor((amountCents * store.applicationFeeBps) / 10000);
      try {
        return await db.$transaction(async (tx) => {
          const child = await tx.donation.create({
            data: {
              storeId: anchor.storeId,
              campaignId: anchor.campaignId,
              userId: anchor.userId,
              type: "monthly",
              amountCents,
              status: "paid",
              anonymous: anchor.anonymous,
              message: anchor.message,
              subscriptionRef,
              providerInvoiceId: invoiceId,
              payment: {
                create: {
                  provider: "stripe",
                  providerId: invoiceId,
                  amountCents,
                  applicationFeeCents,
                  status: "succeeded",
                },
              },
            },
          });
          await tx.outboxEvent.create({
            data: { type: "donation.received", payload: { donationId: child.id } },
          });
          return { donationId: child.id, created: true };
        });
      } catch (err) {
        // Corrida entre duas entregas do mesmo invoice: o @unique é o árbitro final.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          return null;
        }
        throw err;
      }
    },

    isDonationSubscription: async (subscriptionRef) => {
      const found = await db.donation.findFirst({
        where: { subscriptionRef },
        select: { id: true },
      });
      return found !== null;
    },

    markSubscriptionCancelled: async (subscriptionRef) => {
      const updated = await db.donation.updateMany({
        where: { subscriptionRef, subscriptionCancelledAt: null },
        data: { subscriptionCancelledAt: new Date() },
      });
      return updated.count > 0;
    },
  };
}

export function toDonationResponse(donation: DonationWithDetails) {
  return {
    id: donation.id,
    store: { slug: donation.store.slug, name: donation.store.name },
    campaign: donation.campaign
      ? { slug: donation.campaign.slug, title: donation.campaign.title }
      : null,
    type: donation.type,
    amountCents: donation.amountCents,
    currency: donation.currency,
    status: donation.status,
    anonymous: donation.anonymous,
    message: donation.message,
    // Assinatura viva = mensal, paga e sem cancelamento registrado. Nunca expõe
    // subscriptionRef (é credencial operacional do provedor).
    subscriptionActive:
      donation.type === "monthly" &&
      donation.subscriptionRef !== null &&
      donation.subscriptionCancelledAt === null,
    raffleNumbers: donation.entries.map((e) => e.number),
    createdAt: donation.createdAt.toISOString(),
  };
}

export function toStoreDonationResponse(donation: DonationWithDonor) {
  return {
    ...toDonationResponse(donation),
    donor: {
      name: donation.user.name,
      email: donation.user.email,
      phone: donation.user.phone,
    },
  };
}
