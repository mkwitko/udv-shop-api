import type { FastifyRequest } from "fastify";
import { db } from "../../../infra/db/client.js";
import { ConflictError, NotFoundError } from "../../../shared/errors.js";
import { requireStoreRole, type StoreRoleName } from "../../hooks/store-role.js";
import { createStoresRepository } from "../stores/stores.repository.js";

export async function resolveStoreForRole(req: FastifyRequest, minRole: StoreRoleName) {
  const { slug } = req.params as { slug: string };
  const store = await createStoresRepository(db).findBySlug(slug);
  if (!store) throw new NotFoundError("store_not_found");
  requireStoreRole(req, store.id, minRole);
  return store;
}

// Visibilidade pública mora num lugar só (stores/store-visibility.ts); aqui fica o
// re-export para os controllers de campanha/sorteio que já importavam daqui.
export { isStoreMember } from "../stores/store-visibility.js";

/**
 * Capa tem de ser uma das fotos da galeria: capa solta é uma imagem que a loja vê na
 * página e não encontra em lugar nenhum para trocar.
 */
export function assertCoverInGallery(
  coverImage: string | null | undefined,
  images: string[] | undefined,
  current: { coverImage: string | null; images: string[] },
): void {
  if (coverImage === undefined || coverImage === null) return;
  const gallery = images ?? current.images;
  if (gallery.length === 0 || gallery.includes(coverImage)) return;
  throw new ConflictError("cover_not_in_gallery");
}
