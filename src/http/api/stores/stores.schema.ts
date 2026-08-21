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
  /** Pedido de quem escreve: "mais curto", "cita a horta". Vira contexto, não regra. */
  instruction: z.string().max(300).optional(),
});
export type SuggestStoreDescriptionBody = z.infer<typeof SuggestStoreDescriptionBody>;

export const SuggestStoreDescriptionResponse = z.object({ text: z.string() });

/**
 * Identidade visual da loja, guardada em `Store.branding`. Só as chaves do R2 vão para o
 * banco; as URLs são derivadas na resposta, como nas fotos de produto. Era `unknown` e
 * ninguém escrevia — sem tipo, a vitrine não tinha como confiar no que vinha.
 */
export const StoreBrandingInput = z.object({
  logoKey: z.string().startsWith("stores/").max(300).nullable().optional(),
  coverKey: z.string().startsWith("stores/").max(300).nullable().optional(),
});
export type StoreBrandingInput = z.infer<typeof StoreBrandingInput>;

export const StoreBrandingResponse = z.object({
  logoKey: z.string().nullable(),
  coverKey: z.string().nullable(),
  logoUrl: z.string().nullable(),
  coverUrl: z.string().nullable(),
});

export const StoreResponse = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(["pending", "active", "suspended"]),
  branding: StoreBrandingResponse.nullable(),
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
  branding: StoreBrandingInput.optional(),
});
export type UpdateStoreBody = z.infer<typeof UpdateStoreBody>;

export const UpdateStoreStatusBody = z.object({
  status: z.enum(["pending", "active", "suspended"]),
});
export type UpdateStoreStatusBody = z.infer<typeof UpdateStoreStatusBody>;
