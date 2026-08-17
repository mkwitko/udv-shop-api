import type { FastifyRequest } from "fastify";
import { ForbiddenError } from "../../shared/errors.js";
import { requireUser } from "./auth.js";

const ORDER = { staff: 1, admin: 2, owner: 3 } as const;
export type StoreRoleName = keyof typeof ORDER;

export function requireStoreRole(
  req: FastifyRequest,
  storeId: string,
  min: StoreRoleName = "staff",
): ReturnType<typeof requireUser> {
  const user = requireUser(req);
  if (user.platformAdmin) return user;
  const role = user.roles[storeId] as StoreRoleName | undefined;
  if (!role || ORDER[role] < ORDER[min]) throw new ForbiddenError("insufficient_store_role");
  return user;
}

/**
 * Blocks management writes against a `suspended` store (ADR-006 moderation
 * control). `pending` and `active` stores stay writable — a pending store's
 * owner must still be able to configure it before activation. platform_admin
 * always bypasses, so un-suspending via update-store-status is unaffected.
 */
export function requireWritableStore(
  req: FastifyRequest,
  store: { status: string },
): ReturnType<typeof requireUser> {
  const user = requireUser(req);
  if (user.platformAdmin) return user;
  if (store.status === "suspended") throw new ForbiddenError("store_suspended");
  return user;
}
