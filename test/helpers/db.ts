import { db } from "../../src/infra/db/client.js";

export async function resetDb() {
  await db.$transaction([
    db.rafflePrize.deleteMany(),
    db.raffleEntry.deleteMany(),
    db.raffle.deleteMany(),
    db.payment.deleteMany(),
    db.donation.deleteMany(),
    db.campaign.deleteMany(),
    db.orderItem.deleteMany(),
    db.order.deleteMany(),
    db.webhookEvent.deleteMany(),
    db.outboxEvent.deleteMany(),
    db.productInterest.deleteMany(),
    db.product.deleteMany(),
    db.userStoreRole.deleteMany(),
    db.storeSubscription.deleteMany(),
    db.store.deleteMany(),
    db.refreshToken.deleteMany(),
    db.emailToken.deleteMany(),
    db.user.deleteMany(),
  ]);
}
