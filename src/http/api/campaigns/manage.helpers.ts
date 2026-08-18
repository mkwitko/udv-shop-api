import type { FastifyRequest } from "fastify";
import { db } from "../../../infra/db/client.js";
import { NotFoundError } from "../../../shared/errors.js";
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
