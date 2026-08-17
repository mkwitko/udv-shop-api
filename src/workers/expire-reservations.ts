import type { PrismaClient } from "@prisma/client";
import { createOrdersRepository } from "../http/api/orders/orders.repository.js";

export async function expireReservations(deps: { db: PrismaClient }): Promise<number> {
  const orders = createOrdersRepository(deps.db);
  const expired = await orders.listExpiredPending(new Date());
  let cancelled = 0;
  for (const { id } of expired) {
    if (await orders.cancelPendingOrder(id, "expired")) cancelled++;
  }
  return cancelled;
}
