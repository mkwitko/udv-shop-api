import type { PrismaClient } from "@prisma/client";
import { createDonationsRepository } from "../http/api/donations/donations.repository.js";

export async function expireDonations(deps: { db: PrismaClient }): Promise<number> {
  const donations = createDonationsRepository(deps.db);
  const expired = await donations.listExpiredPending(new Date());
  let cancelled = 0;
  for (const { id } of expired) {
    if (await donations.cancelPendingDonation(id, "expired")) cancelled++;
  }
  return cancelled;
}
