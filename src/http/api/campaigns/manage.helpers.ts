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

const STAFF_ROLES = new Set(["owner", "admin", "staff"]);

/** Membro da loja (ou platform_admin) enxerga rascunho e loja não-ativa. */
export function isStoreMember(
  user: { platformAdmin: boolean; roles: Record<string, string> } | null,
  storeId: string | undefined,
): boolean {
  if (!user) return false;
  if (user.platformAdmin) return true;
  return STAFF_ROLES.has(user.roles[storeId ?? ""] ?? "");
}
