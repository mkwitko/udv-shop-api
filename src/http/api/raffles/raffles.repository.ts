import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import {
  afterCursorWhere,
  type CursorPage,
  decodeCursor,
  KEYSET_ORDER_BY,
  toPage,
} from "../../../lib/cursor.js";
import { ConflictError } from "../../../shared/errors.js";
import { drawWinners, RAFFLE_ALGORITHM } from "./draw.js";
import { RAFFLE_MAX_NUMBERS_PER_DONATION, type RafflePrizeInput } from "./raffles.schema.js";

const RAFFLE_INCLUDE = {
  campaign: { select: { slug: true, storeId: true } },
  prizes: {
    orderBy: { position: "asc" },
    include: {
      winnerEntry: {
        include: { user: { select: { name: true } }, donation: { select: { anonymous: true } } },
      },
    },
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
    prizes: RafflePrizeInput[];
  }): Promise<RaffleWithPrizes>;
  findByCampaignId(campaignId: string): Promise<RaffleWithPrizes | null>;
  countEntries(raffleId: string): Promise<{ entries: number; participants: number }>;
  grantNumbersForDonation(donationId: string, log: FastifyBaseLogger): Promise<number>;
  listEntriesCursor(args: {
    raffleId: string;
    limit: number;
    cursor: string | null;
  }): Promise<CursorPage<EntryWithUser>>;
  draw(raffleId: string, seed: string): Promise<RaffleWithPrizes>;
}

/**
 * Reserva a faixa de números de uma doação paga e cria as entradas. Compartilhado pela
 * concessão vinda do outbox (`donation.received`) e pelo backfill do PUT de configuração.
 */
async function grantWithinTx(
  tx: Prisma.TransactionClient,
  raffle: { id: string; centsPerNumber: number },
  donation: { id: string; userId: string; amountCents: number },
  log?: FastifyBaseLogger,
): Promise<number> {
  const uncapped = Math.floor(donation.amountCents / raffle.centsPerNumber);
  if (uncapped < 1) return 0;
  const count = Math.min(uncapped, RAFFLE_MAX_NUMBERS_PER_DONATION);
  if (count < uncapped) {
    log?.warn(
      { donationId: donation.id, uncapped, count },
      "concessão de números limitada pelo teto por doação",
    );
  }

  // Reivindicação: reprocessar donation.received nunca concede número duas vezes.
  const claimed = await tx.donation.updateMany({
    where: { id: donation.id, raffleGranted: false },
    data: { raffleGranted: true },
  });
  if (claimed.count !== 1) return 0;

  // Reserva a faixa com UPDATE ... RETURNING guardado por status: entre a leitura do
  // sorteio e este ponto um sorteio concorrente pode tê-lo fechado, e número emitido
  // depois do draw tem chance zero. O guard trava a linha e falha nesse caso — a claim
  // acima é desfeita para a doação continuar elegível se o sorteio voltar a abrir.
  const reserved = await tx.$queryRaw<Array<{ next_number: number }>>`
    UPDATE raffles SET next_number = next_number + ${count}
    WHERE id = ${raffle.id}::uuid AND status = 'open'
    RETURNING next_number
  `;
  const row = reserved[0];
  if (!row) {
    await tx.donation.updateMany({ where: { id: donation.id }, data: { raffleGranted: false } });
    return 0;
  }
  const start = row.next_number - count;
  await tx.raffleEntry.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      raffleId: raffle.id,
      donationId: donation.id,
      userId: donation.userId,
      number: start + i,
    })),
  });
  return count;
}

/**
 * Linhas de prêmio para `createMany`. Vive aqui porque a criação de campanha com
 * sorteio grava os prêmios na mesma transação, sem passar pelo upsert.
 */
export function prizeCreateData(
  raffleId: string,
  prizes: RafflePrizeInput[],
): Prisma.RafflePrizeCreateManyInput[] {
  return prizes.map((p) => ({
    raffleId,
    position: p.position,
    title: p.title,
    description: p.description ?? null,
    images: p.images ?? [],
  }));
}

export function createRafflesRepository(db: PrismaClient): RafflesRepository {
  return {
    upsertConfig: ({ campaignId, centsPerNumber, drawAt, prizes }) =>
      db.$transaction(async (tx) => {
        const existing = await tx.raffle.findUnique({
          where: { campaignId },
          select: { id: true },
        });
        const raffle = await tx.raffle.upsert({
          where: { campaignId },
          create: { campaignId, centsPerNumber, drawAt },
          update: { centsPerNumber, drawAt },
        });
        // Prêmios são substituídos por inteiro: o PUT é a configuração completa.
        // Só é chamado com o sorteio "open" (o controller garante), então nenhum
        // winnerEntryId é destruído aqui.
        await tx.rafflePrize.deleteMany({ where: { raffleId: raffle.id } });
        await tx.rafflePrize.createMany({ data: prizeCreateData(raffle.id, prizes) });
        // Backfill só na criação: sorteio configurado depois de a campanha já ter
        // recebido doações. Essas doações não vão gerar outro donation.received, então
        // sem isto quem doou antes do PUT ficaria com zero números para sempre. Num PUT
        // de reconfiguração não há o que preencher — dali em diante o outbox concede.
        if (!existing) {
          const ungranted = await tx.donation.findMany({
            where: { campaignId, status: "paid", raffleGranted: false },
            select: { id: true, userId: true, amountCents: true },
            orderBy: { createdAt: "asc" },
          });
          for (const donation of ungranted) {
            await grantWithinTx(tx, raffle, donation);
          }
        }
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
        return grantWithinTx(tx, raffle, donation, log);
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

    draw: (raffleId, seed) =>
      db.$transaction(async (tx) => {
        // Reivindicação atômica: dois cliques no botão de sortear não podem produzir
        // dois sorteios. O segundo perde a claim e recebe 409.
        const claimed = await tx.raffle.updateMany({
          where: { id: raffleId, status: "open" },
          data: { status: "drawn", seed, drawnAt: new Date(), algorithm: RAFFLE_ALGORITHM },
        });
        if (claimed.count !== 1) throw new ConflictError("raffle_not_open");

        const entries = await tx.raffleEntry.findMany({
          where: { raffleId },
          select: { id: true, number: true },
        });
        // Sortear sem participante não é um sorteio. Lançar aqui desfaz a claim junto
        // com a transação, então o sorteio continua "open" para quando houver gente.
        if (entries.length === 0) throw new ConflictError("raffle_has_no_entries");

        const prizes = await tx.rafflePrize.findMany({
          where: { raffleId },
          orderBy: { position: "asc" },
        });
        const winners = drawWinners(
          seed,
          entries.map((e) => e.number),
          prizes.length,
        );
        const idByNumber = new Map(entries.map((e) => [e.number, e.id]));
        for (const [i, prize] of prizes.entries()) {
          const number = winners[i];
          if (number === undefined) break;
          await tx.rafflePrize.update({
            where: { id: prize.id },
            data: { winnerEntryId: idByNumber.get(number) ?? null },
          });
        }
        await tx.outboxEvent.create({ data: { type: "raffle.drawn", payload: { raffleId } } });
        return tx.raffle.findUniqueOrThrow({ where: { id: raffleId }, include: RAFFLE_INCLUDE });
      }),
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
  publicUrl: (key: string) => string,
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
      description: p.description,
      images: p.images,
      imageUrls: p.images.map(publicUrl),
      winner: p.winnerEntry
        ? {
            number: p.winnerEntry.number,
            // Mesma regra da lista de entradas: quem doou anônimo continua anônimo na
            // vitrine. Entregar o prêmio é da gestão, que vê identidade completa.
            participant: maskName(p.winnerEntry.user.name, p.winnerEntry.donation.anonymous),
          }
        : null,
    })),
  };
}
