import { z } from "zod";
import { SLUG_REGEX } from "../stores/stores.schema.js";

export const CreateProductBody = z.object({
  name: z.string().min(2).max(160),
  slug: z.string().min(3).max(80).regex(SLUG_REGEX),
  description: z.string().max(5000).optional(),
  priceCents: z.number().int().positive(),
  images: z.array(z.string().startsWith("stores/")).max(10).optional(),
  stock: z.number().int().min(0).default(0),
  availability: z.enum(["in_stock", "on_demand"]).default("in_stock"),
});
export type CreateProductBody = z.infer<typeof CreateProductBody>;

export const UpdateProductBody = z.object({
  name: z.string().min(2).max(160).optional(),
  description: z.string().max(5000).nullable().optional(),
  priceCents: z.number().int().positive().optional(),
  images: z.array(z.string().startsWith("stores/")).max(10).optional(),
  stock: z.number().int().min(0).optional(),
  availability: z.enum(["in_stock", "on_demand"]).optional(),
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
