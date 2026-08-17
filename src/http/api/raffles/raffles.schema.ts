import { z } from "zod";

// Piso de R$ 1,00 por número: abaixo disso uma doação grande geraria dezenas de
// milhares de linhas. O teto por doação abaixo é a segunda trava.
export const RAFFLE_MIN_CENTS_PER_NUMBER = 100;
export const RAFFLE_MAX_NUMBERS_PER_DONATION = 1000;
export const RAFFLE_MAX_PRIZES = 20;

export const PutRaffleBody = z.object({
  centsPerNumber: z.number().int().min(RAFFLE_MIN_CENTS_PER_NUMBER).max(10_000_000),
  drawAt: z.string().datetime().nullable().optional(),
  prizes: z
    .array(z.object({ position: z.number().int().min(1), title: z.string().min(2).max(200) }))
    .min(1)
    .max(RAFFLE_MAX_PRIZES),
});
export type PutRaffleBody = z.infer<typeof PutRaffleBody>;

export const RafflePrizeResponse = z.object({
  position: z.number().int(),
  title: z.string(),
  winner: z.object({ number: z.number().int(), participant: z.string() }).nullable(),
});

export const RaffleResponse = z.object({
  campaignSlug: z.string(),
  centsPerNumber: z.number().int(),
  drawAt: z.string().nullable(),
  status: z.enum(["open", "drawn", "cancelled"]),
  // Seed só existe depois do sorteio: publicá-la antes deixaria o doador calcular
  // quanto doar para cair no número vencedor (ver D7/ADR-017).
  seed: z.string().nullable(),
  algorithm: z.string(),
  drawnAt: z.string().nullable(),
  totalEntries: z.number().int(),
  totalParticipants: z.number().int(),
  prizes: z.array(RafflePrizeResponse),
});

export const RaffleEntryResponse = z.object({
  number: z.number().int(),
  participant: z.string(),
});

export const RaffleEntriesPageResponse = z.object({
  items: z.array(RaffleEntryResponse),
  nextCursor: z.string().nullable(),
});

export const RaffleEntriesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export const DrawRaffleResponse = z.object({
  seed: z.string(),
  algorithm: z.string(),
  drawnAt: z.string(),
  prizes: z.array(RafflePrizeResponse),
});
