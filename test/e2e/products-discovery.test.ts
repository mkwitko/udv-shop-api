import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

/**
 * Vitrine navegável: filtro por categoria, busca e ordenação precisam funcionar
 * combinados e paginar sem repetir nem perder produto.
 */
describe("descoberta na vitrine", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  async function seed() {
    const store = await db.store.create({
      data: { slug: "nucleo-a", name: "Núcleo A", status: "active" },
    });
    const chas = await db.productCategory.create({
      data: { storeId: store.id, slug: "chas", name: "Chás", position: 0 },
    });
    const arte = await db.productCategory.create({
      data: { storeId: store.id, slug: "arte", name: "Artesanato", position: 1 },
    });
    const base = new Date("2026-08-01T12:00:00.000Z").getTime();
    const rows: Array<{
      slug: string;
      name: string;
      priceCents: number;
      categoryId?: string;
      description?: string;
      active?: boolean;
    }> = [
      { slug: "cha-verde", name: "Chá verde", priceCents: 3000, categoryId: chas.id },
      {
        slug: "cha-mate",
        name: "Chá mate",
        priceCents: 1500,
        categoryId: chas.id,
        description: "Colhido na horta do núcleo",
      },
      { slug: "cesto", name: "Cesto de palha", priceCents: 9000, categoryId: arte.id },
      { slug: "colar", name: "Colar de sementes", priceCents: 4500, categoryId: arte.id },
      { slug: "mel", name: "Mel silvestre", priceCents: 2500 },
      {
        slug: "cha-oculto",
        name: "Chá arquivado",
        priceCents: 100,
        categoryId: chas.id,
        active: false,
      },
    ];
    for (const [index, row] of rows.entries()) {
      await db.product.create({
        data: {
          storeId: store.id,
          slug: row.slug,
          name: row.name,
          priceCents: row.priceCents,
          categoryId: row.categoryId ?? null,
          description: row.description ?? null,
          active: row.active ?? true,
          createdAt: new Date(base + index * 60_000),
        },
      });
    }
    return { store, chas, arte };
  }

  function slugsOf(res: { json: () => { items: Array<{ slug: string }> } }) {
    return res.json().items.map((item) => item.slug);
  }

  it("filtra por categoria e esconde inativo", async () => {
    await seed();
    const res = await app.inject({ method: "GET", url: "/stores/nucleo-a/products?category=chas" });
    expect(res.statusCode).toBe(200);
    expect(slugsOf(res).sort()).toEqual(["cha-mate", "cha-verde"]);
  });

  it("categoria inexistente devolve lista vazia, não erro", async () => {
    await seed();
    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/products?category=nao-existe",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
    expect(res.json().nextCursor).toBeNull();
  });

  it("busca casa nome e descrição, sem ligar para caixa alta", async () => {
    await seed();
    const byName = await app.inject({ method: "GET", url: "/stores/nucleo-a/products?q=CHÁ%20V" });
    expect(slugsOf(byName)).toEqual(["cha-verde"]);

    const byDescription = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/products?q=horta",
    });
    expect(slugsOf(byDescription)).toEqual(["cha-mate"]);
  });

  it("busca com caractere de curinga não vira busca aberta", async () => {
    await seed();
    const res = await app.inject({ method: "GET", url: "/stores/nucleo-a/products?q=%25" });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  it("busca e categoria valem juntas", async () => {
    await seed();
    const res = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/products?category=arte&q=colar",
    });
    expect(slugsOf(res)).toEqual(["colar"]);
  });

  it("ordena por preço nos dois sentidos", async () => {
    await seed();
    const asc = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/products?sort=price_asc",
    });
    expect(slugsOf(asc)).toEqual(["cha-mate", "mel", "cha-verde", "colar", "cesto"]);

    const desc = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/products?sort=price_desc",
    });
    expect(slugsOf(desc)).toEqual(["cesto", "colar", "cha-verde", "mel", "cha-mate"]);
  });

  it("ordem padrão continua sendo o mais recente primeiro", async () => {
    await seed();
    const res = await app.inject({ method: "GET", url: "/stores/nucleo-a/products" });
    expect(slugsOf(res)[0]).toBe("mel");
  });

  it("pagina por preço sem repetir nem perder produto", async () => {
    await seed();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const url: string = `/stores/nucleo-a/products?sort=price_asc&limit=2${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`;
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      seen.push(...slugsOf(res));
      cursor = (res.json() as { nextCursor: string | null }).nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(["cha-mate", "mel", "cha-verde", "colar", "cesto"]);
  });

  it("pagina com preços iguais sem entrar em laço", async () => {
    const store = await db.store.create({
      data: { slug: "nucleo-c", name: "Núcleo C", status: "active" },
    });
    for (let i = 0; i < 5; i++) {
      await db.product.create({
        data: { storeId: store.id, slug: `p-${i}`, name: `P${i}`, priceCents: 1000 },
      });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page++) {
      const url: string = `/stores/nucleo-c/products?sort=price_asc&limit=2${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`;
      const res = await app.inject({ method: "GET", url });
      seen.push(...slugsOf(res));
      cursor = (res.json() as { nextCursor: string | null }).nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(5);
  });

  it("cursor de outra ordenação é recusado, não misturado", async () => {
    await seed();
    const first = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/products?sort=price_asc&limit=2",
    });
    const cursor = first.json().nextCursor as string;
    const mixed = await app.inject({
      method: "GET",
      url: `/stores/nucleo-a/products?limit=2&cursor=${encodeURIComponent(cursor)}`,
    });
    expect(mixed.statusCode).toBe(400);
  });

  it("filtro e ordem sobrevivem à paginação por categoria", async () => {
    await seed();
    const first = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/products?category=arte&sort=price_desc&limit=1",
    });
    expect(slugsOf(first)).toEqual(["cesto"]);
    const second = await app.inject({
      method: "GET",
      url: `/stores/nucleo-a/products?category=arte&sort=price_desc&limit=1&cursor=${encodeURIComponent(
        first.json().nextCursor as string,
      )}`,
    });
    expect(slugsOf(second)).toEqual(["colar"]);
    expect(second.json().nextCursor).toBeNull();
  });

  it("termo de busca gigante é recusado", async () => {
    await seed();
    const res = await app.inject({
      method: "GET",
      url: `/stores/nucleo-a/products?q=${"a".repeat(200)}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("sort inválido é recusado", async () => {
    await seed();
    const res = await app.inject({ method: "GET", url: "/stores/nucleo-a/products?sort=roubo" });
    expect(res.statusCode).toBe(400);
  });
});
