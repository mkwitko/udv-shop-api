import { db } from "../../src/infra/db/client.js";

export async function resetDb() {
  await db.$transaction([
    db.product.deleteMany(),
    db.userStoreRole.deleteMany(),
    db.store.deleteMany(),
    db.refreshToken.deleteMany(),
    db.emailToken.deleteMany(),
    db.user.deleteMany(),
  ]);
}
