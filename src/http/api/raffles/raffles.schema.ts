import { z } from "zod";
import { ValidationError } from "../../../shared/errors.js";

// Piso de R$ 1,00 por número: abaixo disso uma doação grande geraria dezenas de
// milhares de linhas. O teto por doação abaixo é a segunda trava.
export const RAFFLE_MIN_CENTS_PER_NUMBER = 100;
export const RAFFLE_MAX_NUMBERS_PER_DONATION = 1000;
export const RAFFLE_MAX_PRIZES = 20;
export const RAFFLE_MAX_PRIZE_IMAGES = 6;

/** Prêmio como a gestão descreve: texto livre e fotos, sem vínculo com o catálogo. */
export const RafflePrizeInput = z.object({
  position: z.number().int().min(1),
  title: z.string().min(2).max(200),
  description: z.string().max(2000).optional(),
  // Mesma trava do produto: só key vinda do nosso presign entra, senão a vitrine
  // renderiza URL de terceiro.
  images: z
    .array(z.string().startsWith("stores/").max(300))
    .max(RAFFLE_MAX_PRIZE_IMAGES)
    .optional(),
});
export type RafflePrizeInput = z.infer<typeof RafflePrizeInput>;

/** Configuração do sorteio, reusada no PUT e na criação da campanha. */
export const RaffleConfigInput = z.object({
  centsPerNumber: z.number().int().min(RAFFLE_MIN_CENTS_PER_NUMBER).max(10_000_000),
  drawAt: z.string().datetime().nullable().optional(),
  prizes: z.array(RafflePrizeInput).min(1).max(RAFFLE_MAX_PRIZES),
});
export type RaffleConfigInput = z.infer<typeof RaffleConfigInput>;

/**
 * Duas posições iguais deixariam a ordem dos prêmios ao acaso do banco. Fora do zod
 * porque a mensagem é contrato de erro do PUT (`duplicate_prize_position`).
 */
export function assertUniquePrizePositions(prizes: RafflePrizeInput[]): void {
  const positions = prizes.map((p) => p.position);
  if (new Set(positions).size !== positions.length) {
    throw new ValidationError("duplicate_prize_position");
  }
}

export const PutRaffleBody = RaffleConfigInput;
export type PutRaffleBody = z.infer<typeof PutRaffleBody>;

export const RafflePrizeResponse = z.object({
  position: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  images: z.array(z.string()),
  imageUrls: z.array(z.string()),
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

/**
 * Entrada da sugestão de descrição do prêmio. Sem id de campanha: na criação da campanha
 * o prêmio ainda não existe em lugar nenhum, e a IA só precisa do que a pessoa digitou.
 */
export const SuggestPrizeDescriptionBody = z.object({
  prizeTitle: z.string().min(2).max(200),
  campaignTitle: z.string().max(160).optional(),
  draft: z.string().max(4000).optional(),
  mode: z.enum(["create", "improve"]).default("create"),
});
export type SuggestPrizeDescriptionBody = z.infer<typeof SuggestPrizeDescriptionBody>;

export const SuggestPrizeDescriptionResponse = z.object({ text: z.string() });

export const DrawRaffleResponse = z.object({
  seed: z.string(),
  algorithm: z.string(),
  drawnAt: z.string(),
  prizes: z.array(RafflePrizeResponse),
});
