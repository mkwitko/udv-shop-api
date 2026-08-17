import { z } from "zod";

export const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const CreateStoreBody = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().min(3).max(60).regex(SLUG_REGEX),
  description: z.string().max(2000).optional(),
});
export type CreateStoreBody = z.infer<typeof CreateStoreBody>;

export const StoreResponse = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(["pending", "active", "suspended"]),
  branding: z.unknown().nullable(),
  createdAt: z.string(),
});

export const StoresPageResponse = z.object({
  items: z.array(StoreResponse),
  nextCursor: z.string().nullable(),
});

export const ListStoresQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});
export type ListStoresQuery = z.infer<typeof ListStoresQuery>;
