import { z } from "zod";
import { PayoutKindSchema } from "../payouts/payouts.schema.js";
import { SLUG_REGEX } from "../stores/stores.schema.js";

/**
 * Acordo de repasse do produto. Os três campos andam juntos: `null` nos três
 * significa "a loja fica com tudo menos a taxa".
 */
const PayoutFields = {
  supplierId: z.string().uuid().nullable().optional(),
  payoutKind: PayoutKindSchema.nullable().optional(),
  payoutValue: z.number().int().min(0).nullable().optional(),
};

export const CreateProductBody = z.object({
  name: z.string().min(2).max(160),
  slug: z.string().min(3).max(80).regex(SLUG_REGEX),
  description: z.string().max(5000).optional(),
  priceCents: z.number().int().positive(),
  images: z.array(z.string().startsWith("stores/")).max(10).optional(),
  stock: z.number().int().min(0).default(0),
  availability: z.enum(["in_stock", "on_demand"]).default("in_stock"),
  ...PayoutFields,
});
export type CreateProductBody = z.infer<typeof CreateProductBody>;

export const UpdateProductBody = z.object({
  name: z.string().min(2).max(160).optional(),
  description: z.string().max(5000).nullable().optional(),
  priceCents: z.number().int().positive().optional(),
  images: z.array(z.string().startsWith("stores/")).max(10).optional(),
  stock: z.number().int().min(0).optional(),
  availability: z.enum(["in_stock", "on_demand"]).optional(),
  ...PayoutFields,
});
export type UpdateProductBody = z.infer<typeof UpdateProductBody>;

export const ProductResponse = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  priceCents: z.number().int(),
  currency: z.string(),
  images: z.array(z.string()),
  imageUrls: z.array(z.string()),
  stock: z.number().int(),
  availability: z.enum(["in_stock", "on_demand"]),
  active: z.boolean(),
  createdAt: z.string(),
  /**
   * Só quem cuida da loja recebe isto preenchido: quanto do preço é combinado com
   * o parceiro é acordo interno, não vitrine.
   */
  payout: z
    .object({
      supplierId: z.string(),
      supplierName: z.string(),
      kind: PayoutKindSchema,
      value: z.number().int(),
      unitCents: z.number().int(),
    })
    .nullable(),
});

export const ProductsPageResponse = z.object({
  items: z.array(ProductResponse),
  nextCursor: z.string().nullable(),
});

export const ListProductsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
  all: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default(false),
});
export type ListProductsQuery = z.infer<typeof ListProductsQuery>;

/** Entrada da sugestão de descrição. `draft` é o que a loja já escreveu (pode ser nota solta). */
export const SuggestDescriptionBody = z.object({
  name: z.string().min(2).max(160),
  draft: z.string().max(2000).optional(),
  mode: z.enum(["create", "improve"]).default("create"),
});
export type SuggestDescriptionBody = z.infer<typeof SuggestDescriptionBody>;

export const SuggestDescriptionResponse = z.object({ text: z.string() });
