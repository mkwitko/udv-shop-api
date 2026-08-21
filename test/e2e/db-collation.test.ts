import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";

/**
 * Trava a collation do cluster. Sem ICU pt-BR o Postgres ordena por byte e "Água" cai depois
 * de "Zebra" — a vitrine da loja lista produto por nome, então isso é bug visível ao cliente.
 * O conserto exige recriar o cluster, então o teste existe para o defeito nunca voltar calado.
 */
describe("collation do banco", () => {
  beforeAll(async () => {
    await resetDb();
    const store = await db.store.create({
      data: { slug: "collation", name: "Collation", status: "active" },
    });
    await db.product.createMany({
      data: [
        { storeId: store.id, slug: "zebra", name: "Zebra", priceCents: 1000 },
        { storeId: store.id, slug: "agua", name: "Água", priceCents: 1000 },
        { storeId: store.id, slug: "banana", name: "Banana", priceCents: 1000 },
      ],
    });
  });

  afterAll(async () => {
    await resetDb();
  });

  it("ordena acento como gente, não como byte", async () => {
    const rows = await db.product.findMany({
      orderBy: { name: "asc" },
      select: { name: true },
    });
    expect(rows.map((r) => r.name)).toEqual(["Água", "Banana", "Zebra"]);
  });

  it("cluster usa o provider ICU", async () => {
    const rows = await db.$queryRaw<{ provider: string }[]>`
      SELECT datlocprovider::text AS provider
      FROM pg_database
      WHERE datname = current_database()
    `;
    expect(rows[0]?.provider).toBe("i");
  });
});
