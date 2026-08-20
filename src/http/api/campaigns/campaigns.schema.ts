import { z } from "zod";
import { RaffleConfigInput } from "../raffles/raffles.schema.js";
import { SLUG_REGEX } from "../stores/stores.schema.js";

export const CAMPAIGN_STATUSES = ["draft", "active", "paused", "finished"] as const;
export const CAMPAIGN_ACCEPTED_TYPES = ["one_time", "monthly", "both"] as const;

export const CreateCampaignBody = z.object({
  slug: z.string().min(3).max(80).regex(SLUG_REGEX),
  title: z.string().min(2).max(160),
  story: z.string().max(10_000).optional(),
  coverImage: z.string().startsWith("stores/").max(300).optional(),
  goalCents: z.number().int().positive().max(1_000_000_000).optional(),
  acceptedTypes: z.enum(CAMPAIGN_ACCEPTED_TYPES).default("both"),
  endsAt: z.string().datetime().optional(),
  /**
   * Sorteio junto da campanha. Criado na mesma transação: com duas chamadas, uma
   * falha no sorteio deixaria a campanha nascida pela metade sem ninguém saber.
   */
  raffle: RaffleConfigInput.optional(),
});
export type CreateCampaignBody = z.infer<typeof CreateCampaignBody>;

export const UpdateCampaignBody = z.object({
  title: z.string().min(2).max(160).optional(),
  story: z.string().max(10_000).nullable().optional(),
  coverImage: z.string().startsWith("stores/").max(300).nullable().optional(),
  goalCents: z.number().int().positive().max(1_000_000_000).nullable().optional(),
  acceptedTypes: z.enum(CAMPAIGN_ACCEPTED_TYPES).optional(),
  endsAt: z.string().datetime().nullable().optional(),
});
export type UpdateCampaignBody = z.infer<typeof UpdateCampaignBody>;

export const UpdateCampaignStatusBody = z.object({ status: z.enum(CAMPAIGN_STATUSES) });

export const CampaignResponse = z.object({
  id: z.string(),
  store: z.object({ slug: z.string(), name: z.string() }),
  slug: z.string(),
  title: z.string(),
  story: z.string().nullable(),
  coverImage: z.string().nullable(),
  coverImageUrl: z.string().nullable(),
  goalCents: z.number().int().nullable(),
  raisedCents: z.number().int(),
  donationCount: z.number().int(),
  acceptedTypes: z.enum(CAMPAIGN_ACCEPTED_TYPES),
  status: z.enum(CAMPAIGN_STATUSES),
  endsAt: z.string().nullable(),
  createdAt: z.string(),
});

export const CampaignsPageResponse = z.object({
  items: z.array(CampaignResponse),
  nextCursor: z.string().nullable(),
});

export const ListCampaignsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
  // zod4: nunca z.coerce.boolean() aqui — "false" viraria true.
  all: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default(false),
});
export type ListCampaignsQuery = z.infer<typeof ListCampaignsQuery>;

/** Entrada da sugestão de história. `draft` é o que a comunidade já escreveu. */
export const SuggestStoryBody = z.object({
  title: z.string().min(2).max(160),
  draft: z.string().max(4000).optional(),
  mode: z.enum(["create", "improve"]).default("create"),
});
export type SuggestStoryBody = z.infer<typeof SuggestStoryBody>;

export const SuggestStoryResponse = z.object({ text: z.string() });
