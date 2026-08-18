import { NotFoundError } from "../../../shared/errors.js";

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

/**
 * Leitura pública de uma loja e do que pende dela.
 *
 * Loja `pending` nunca foi publicada: 404 esconde até a existência dela.
 * Loja `suspended` já esteve no ar — o link está em grupo de WhatsApp, em cartaz,
 * no histórico de quem comprou. Devolver 404 aí seria mentir sobre um endereço que
 * existe; a loja continua legível e a página pública diz que está fora do ar.
 * Escrita segue barrada em `requireWritableStore`, e checkout/doação exigem `active`.
 */
export function assertStoreReadable<T extends { id: string; status: string }>(
  store: T | null,
  user: { platformAdmin: boolean; roles: Record<string, string> } | null,
): asserts store is T {
  if (!store) throw new NotFoundError("store_not_found");
  if (store.status === "active") return;
  if (isStoreMember(user, store.id)) return;
  if (store.status === "suspended") return;
  throw new NotFoundError("store_not_found");
}
