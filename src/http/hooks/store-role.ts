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
