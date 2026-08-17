import { z } from "zod";

export const INTEREST_STATUSES = ["open", "notified", "converted", "cancelled"] as const;

export const CreateInterestBody = z.object({
  storeSlug: z.string().min(1),
  productSlug: z.string().min(1),
  qty: z.number().int().min(1).max(99).default(1),
  note: z.string().max(500).optional(),
});
export type CreateInterestBody = z.infer<typeof CreateInterestBody>;

export const InterestResponse = z.object({
  id: z.string(),
  store: z.object({ slug: z.string(), name: z.string() }),
  product: z.object({
    slug: z.string(),
    name: z.string(),
    priceCents: z.number().int(),
    availability: z.string(),
  }),
  qty: z.number().int(),
  status: z.string(),
  note: z.string().nullable(),
  notifiedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const InterestsPageResponse = z.object({
  items: z.array(InterestResponse),
  nextCursor: z.string().nullable(),
});

export const InterestsListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
  status: z.enum(INTEREST_STATUSES).optional(),
});

export const StoreInterestsQuery = InterestsListQuery.extend({
  productSlug: z.string().min(1).optional(),
});

export const InterestDemandResponse = z.object({
  items: z.array(
    z.object({
      product: z.object({
        slug: z.string(),
        name: z.string(),
        priceCents: z.number().int(),
        availability: z.string(),
      }),
      openCount: z.number().int(),
      notifiedCount: z.number().int(),
      totalQty: z.number().int(),
    }),
  ),
});

export const NotifyInterestsResponse = z.object({ notified: z.number().int() });

// Teto da resposta de demanda: a lista paginada de interesses cobre o caso detalhado.
export const DEMAND_MAX_PRODUCTS = 100;
