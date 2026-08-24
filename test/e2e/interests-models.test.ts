import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";

async function seedProductAndUser() {
  const store = await db.store.create({
    data: { slug: "nucleo-a", name: "Núcleo A", status: "active" },
  });
  const product = await db.product.create({
    data: {
      storeId: store.id,
      slug: "cha-especial",
      name: "Chá especial",
      priceCents: 5000,
      availability: "on_demand",
    },
  });
  const user = await db.user.create({
    data: { email: "cliente@example.org", name: "Cliente", passwordHash: "x" },
  });
  return { store, product, user };
}

describe("modelo ProductInterest", () => {
  beforeEach(resetDb);

  it("nasce open com qty 1 e sem notifiedAt", async () => {
    const { product, user } = await seedProductAndUser();
    const interest = await db.interest.create({
      data: { productId: product.id, userId: user.id },
    });
    expect(interest.status).toBe("open");
    expect(interest.qty).toBe(1);
    expect(interest.notifiedAt).toBeNull();
    expect(interest.note).toBeNull();
  });

  it("é único por (produto, usuário)", async () => {
    const { product, user } = await seedProductAndUser();
    await db.interest.create({ data: { productId: product.id, userId: user.id } });
    await expect(
      db.interest.create({ data: { productId: product.id, userId: user.id } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("cascata ao apagar o produto", async () => {
    const { product, user } = await seedProductAndUser();
    await db.interest.create({ data: { productId: product.id, userId: user.id } });
    await db.product.delete({ where: { id: product.id } });
    expect(await db.interest.count()).toBe(0);
  });

  it("cascata ao apagar o usuário", async () => {
    const { product, user } = await seedProductAndUser();
    await db.interest.create({ data: { productId: product.id, userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
    expect(await db.interest.count()).toBe(0);
  });
});
