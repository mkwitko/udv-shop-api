import type { FastifyRequest } from "fastify";
import { db } from "../../../infra/db/client.js";
import { NotFoundError } from "../../../shared/errors.js";
import { requireStoreRole, type StoreRoleName } from "../../hooks/store-role.js";
import { createStoresRepository } from "./stores.repository.js";

/**
 * Resolve a loja do `:slug` e exige o papel mínimo. Módulos antigos têm cópias
 * locais deste helper; módulos novos importam daqui.
 */
export async function resolveStoreForRole(req: FastifyRequest, minRole: StoreRoleName) {
  const { slug } = req.params as { slug: string };
  const store = await createStoresRepository(db).findBySlug(slug);
  if (!store) throw new NotFoundError("store_not_found");
  requireStoreRole(req, store.id, minRole);
  return store;
}
