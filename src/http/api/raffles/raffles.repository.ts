import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import {
  afterCursorWhere,
  type CursorPage,
  decodeCursor,
  KEYSET_ORDER_BY,
  toPage,
} from "../../../lib/cursor.js";
import { RAFFLE_MAX_NUMBERS_PER_DONATION } from "./raffles.schema.js";

const RAFFLE_INCLUDE = {
  campaign: { select: { slug: true, storeId: true } },
  prizes: {
    orderBy: { position: "asc" },
    include: { winnerEntry: { include: { user: { select: { name: true } } } } },
  },
} satisfies Prisma.RaffleInclude;

export type RaffleWithPrizes = Prisma.RaffleGetPayload<{ include: typeof RAFFLE_INCLUDE }>;

export type EntryWithUser = Prisma.RaffleEntryGetPayload<{
  include: { user: { select: { name: true } }; donation: { select: { anonymous: true } } };
}>;

export interface RafflesRepository {
  upsertConfig(input: {
    campaignId: string;
    centsPerNumber: number;
    drawAt: Date | null;
    prizes: Array<{ position: number; title: string }>;
  }): Promise<RaffleWithPrizes>;
  findByCampaignId(campaignId: string): Promise<RaffleWithPrizes | null>;
  countEntries(raffleId: string): Promise<{ entries: number; participants: number }>;
  grantNumbersForDonation(donationId: string, log: FastifyBaseLogger): Promise<number>;
  listEntriesCursor(args: {
    raffleId: string;
    limit: number;
    cursor: string | null;
  }): Promise<CursorPage<EntryWithUser>>;
}

export function createRafflesRepository(db: PrismaClient): RafflesRepository {
  return {
    upsertConfig: ({ campaignId, centsPerNumber, drawAt, prizes }) =>
      db.$transaction(async (tx) => {
        const raffle = await tx.raffle.upsert({
          where: { campaignId },
          create: { campaignId, centsPerNumber, drawAt },
          update: { centsPerNumber, drawAt },
        });
        // Prêmios são substituídos por inteiro: o PUT é a configuração completa.
        // Só é chamado com o sorteio "open" (o controller garante), então nenhum
        // winnerEntryId é destruído aqui.
        await tx.rafflePrize.deleteMany({ where: { raffleId: raffle.id } });
        await tx.rafflePrize.createMany({
          data: prizes.map((p) => ({ raffleId: raffle.id, position: p.position, title: p.title })),
        });
        return tx.raffle.findUniqueOrThrow({ where: { id: raffle.id }, include: RAFFLE_INCLUDE });
      }),

    findByCampaignId: (campaignId) =>
      db.raffle.findUnique({ where: { campaignId }, include: RAFFLE_INCLUDE }),

    countEntries: async (raffleId) => {
      const [entries, participants] = await Promise.all([
        db.raffleEntry.count({ where: { raffleId } }),
        db.raffleEntry.groupBy({ by: ["userId"], where: { raffleId } }),
      ]);
      return { entries, participants: participants.length };
    },

    grantNumbersForDonation: (donationId, log) =>
      db.$transaction(async (tx) => {
        const donation = await tx.donation.findUnique({
          where: { id: donationId },
          select: {
            id: true,
            userId: true,
            campaignId: true,
            amountCents: true,
            status: true,
          },
        });
        if (!donation || donation.status !== "paid" || !donation.campaignId) return 0;
        const raffle = await tx.raffle.findUnique({ where: { campaignId: donation.campaignId } });
        if (!raffle || raffle.status !== "open") return 0;

        const uncapped = Math.floor(donation.amountCents / raffle.centsPerNumber);
        if (uncapped < 1) return 0;
        const count = Math.min(uncapped, RAFFLE_MAX_NUMBERS_PER_DONATION);
        if (count < uncapped) {
          log.warn(
            { donationId, uncapped, count },
            "concessão de números limitada pelo teto por doação",
          );
        }

        // Reivindicação: reprocessar donation.received nunca concede número duas vezes.
        const claimed = await tx.donation.updateMany({
          where: { id: donation.id, raffleGranted: false },
          data: { raffleGranted: true },
        });
        if (claimed.count !== 1) return 0;

        // Reserva a faixa com um UPDATE que trava a linha do sorteio: dois
        // donation.received concorrentes serializam aqui em vez de colidirem no
        // unique (raffleId, number).
        const updated = await tx.raffle.update({
          where: { id: raffle.id },
          data: { nextNumber: { increment: count } },
          select: { nextNumber: true },
        });
        const start = updated.nextNumber - count;
        await tx.raffleEntry.createMany({
          data: Array.from({ length: count }, (_, i) => ({
            raffleId: raffle.id,
            donationId: donation.id,
            userId: donation.userId,
            number: start + i,
          })),
        });
        return count;
      }),

    listEntriesCursor: async ({ raffleId, limit, cursor }) => {
      const after = cursor ? afterCursorWhere(decodeCursor(cursor)) : {};
      const rows = await db.raffleEntry.findMany({
        where: { raffleId, ...after },
        orderBy: [...KEYSET_ORDER_BY],
        take: limit + 1,
        include: {
          user: { select: { name: true } },
          donation: { select: { anonymous: true } },
        },
      });
      return toPage(
        rows,
        limit,
        (r) => ({ createdAt: r.createdAt, id: r.id }),
        (r) => r,
      );
    },
  };
}

/**
 * Vitrine pública nunca mostra identidade: "Maria Silva" vira "Maria S.", doação
 * anônima vira "Doador anônimo". Email, telefone e id jamais saem daqui (ver D11).
 */
export function maskName(name: string, anonymous: boolean): string {
  if (anonymous) return "Doador anônimo";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "Doador anônimo";
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return last ? `${first} ${last[0]?.toUpperCase()}.` : first;
}

export function toRaffleResponse(
  raffle: RaffleWithPrizes,
  counts: { entries: number; participants: number },
) {
  return {
    campaignSlug: raffle.campaign.slug,
    centsPerNumber: raffle.centsPerNumber,
    drawAt: raffle.drawAt?.toISOString() ?? null,
    status: raffle.status,
    seed: raffle.seed,
    algorithm: raffle.algorithm,
    drawnAt: raffle.drawnAt?.toISOString() ?? null,
    totalEntries: counts.entries,
    totalParticipants: counts.participants,
    prizes: raffle.prizes.map((p) => ({
      position: p.position,
      title: p.title,
      winner: p.winnerEntry
        ? { number: p.winnerEntry.number, participant: maskName(p.winnerEntry.user.name, false) }
        : null,
    })),
  };
}
