import type { Prisma, RaffleStatus } from "@prisma/client";

export type ResolvedRaffle = { id: string; status: RaffleStatus; centsPerNumber: number };

/**
 * Sorteio a que uma doação paga concorre.
 *
 * 1. o sorteio cuja janela contém `paidAt` — **de qualquer status**;
 * 2. senão, o sorteio `open` com o menor `startsAt` posterior a `paidAt`;
 * 3. senão, nenhum (a doação fica pendente até alguém criar um sorteio que a cubra).
 *
 * O passo 1 ignorar o status é o que impede a doação de agosto — cujo sorteio já foi
 * realizado — de escorregar para o sorteio de setembro e concorrer duas vezes com o
 * mesmo dinheiro. Janela casada é ponto final: quem chama confere `status` e concede
 * zero se o sorteio não estiver mais aberto.
 */
export async function resolveRaffleForDonation(
  tx: Prisma.TransactionClient,
  campaignId: string,
  paidAt: Date,
): Promise<ResolvedRaffle | null> {
  const containing = await tx.raffle.findFirst({
    where: {
      campaignId,
      startsAt: { lte: paidAt },
      OR: [{ endsAt: null }, { endsAt: { gt: paidAt } }],
    },
    select: { id: true, status: true, centsPerNumber: true },
  });
  if (containing) return containing;

  return tx.raffle.findFirst({
    where: { campaignId, status: "open", startsAt: { gt: paidAt } },
    orderBy: { startsAt: "asc" },
    select: { id: true, status: true, centsPerNumber: true },
  });
}

/**
 * Sorteio da mesma campanha cuja janela colide com a informada, se houver. `endsAt`
 * nulo conta como infinito nos dois lados — é por isso que um sorteio corrente sem
 * fim colide com qualquer janela futura, e a flag `openEnded` existe para a rota
 * dizer "feche a janela do sorteio corrente antes de criar o próximo" em vez de um
 * "sobreposição" que a pessoa não sabe resolver.
 */
export async function findWindowConflict(
  tx: Prisma.TransactionClient,
  input: {
    campaignId: string;
    startsAt: Date;
    endsAt: Date | null;
    exceptRaffleId?: string | undefined;
  },
): Promise<{ sequence: number; openEnded: boolean } | null> {
  const conflict = await tx.raffle.findFirst({
    where: {
      campaignId: input.campaignId,
      ...(input.exceptRaffleId !== undefined && { id: { not: input.exceptRaffleId } }),
      // existente começa antes do fim do novo
      ...(input.endsAt !== null && { startsAt: { lt: input.endsAt } }),
      // existente termina depois do início do novo
      OR: [{ endsAt: null }, { endsAt: { gt: input.startsAt } }],
    },
    orderBy: { startsAt: "asc" },
    select: { sequence: true, endsAt: true },
  });
  if (!conflict) return null;
  return { sequence: conflict.sequence, openEnded: conflict.endsAt === null };
}
