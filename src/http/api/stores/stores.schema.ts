import { z } from "zod";

export const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const CreateStoreBody = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().min(3).max(60).regex(SLUG_REGEX),
  description: z.string().max(2000).optional(),
});
export type CreateStoreBody = z.infer<typeof CreateStoreBody>;

/**
 * Entrada da sugestão de descrição da loja. Não é escopada por loja: o campo aparece no
 * cadastro, quando a loja ainda não existe — o nome digitado é todo o contexto.
 */
export const SuggestStoreDescriptionBody = z.object({
  name: z.string().min(2).max(120),
  draft: z.string().max(4000).optional(),
  mode: z.enum(["create", "improve"]).default("create"),
});
export type SuggestStoreDescriptionBody = z.infer<typeof SuggestStoreDescriptionBody>;

export const SuggestStoreDescriptionResponse = z.object({ text: z.string() });

export const StoreResponse = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(["pending", "active", "suspended"]),
  branding: z.unknown().nullable(),
  createdAt: z.string(),
});

export const MyStoreResponse = StoreResponse.extend({
  role: z.enum(["owner", "admin", "staff"]),
});

export const MyStoresResponse = z.object({
  items: z.array(MyStoreResponse),
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

export const AdminListStoresQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
  status: z.enum(["pending", "active", "suspended"]).optional(),
});
export type AdminListStoresQuery = z.infer<typeof AdminListStoresQuery>;

export const UpdateStoreBody = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  branding: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateStoreBody = z.infer<typeof UpdateStoreBody>;

export const UpdateStoreStatusBody = z.object({
  status: z.enum(["pending", "active", "suspended"]),
});
export type UpdateStoreStatusBody = z.infer<typeof UpdateStoreStatusBody>;
