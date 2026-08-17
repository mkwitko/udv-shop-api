import { db } from "../../src/infra/db/client.js";

export async function resetDb() {
  await db.$transaction([
    db.refreshToken.deleteMany(),
    db.emailToken.deleteMany(),
    db.user.deleteMany(),
  ]);
}
