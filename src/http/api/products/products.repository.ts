import type { PrismaClient, Product } from "@prisma/client";
import {
  afterCursorWhere,
  type CursorPage,
  decodeCursor,
  KEYSET_ORDER_BY,
  toPage,
} from "../../../lib/cursor.js";
import type { CreateProductBody, UpdateProductBody } from "./products.schema.js";

export interface ProductsRepository {
  findBySlug(storeId: string, slug: string): Promise<Product | null>;
  create(storeId: string, data: CreateProductBody): Promise<Product>;
  update(id: string, data: UpdateProductBody): Promise<Product>;
  archive(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  listByStoreCursor(args: {
    storeId: string;
    limit: number;
    cursor: string | null;
    includeInactive: boolean;
  }): Promise<CursorPage<Product>>;
  findActiveBySlugs(storeId: string, slugs: string[]): Promise<Product[]>;
}

export function createProductsRepository(db: PrismaClient): ProductsRepository {
  return {
    findBySlug: (storeId, slug) =>
      db.product.findUnique({ where: { storeId_slug: { storeId, slug } } }),
    create: (storeId, data) =>
      db.product.create({
        data: {
          storeId,
          name: data.name,
          slug: data.slug,
          description: data.description ?? null,
          priceCents: data.priceCents,
          images: data.images ?? [],
          stock: data.stock,
          availability: data.availability,
        },
      }),
    update: (id, data) =>
      db.product.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.priceCents !== undefined && { priceCents: data.priceCents }),
          ...(data.images !== undefined && { images: data.images }),
          ...(data.stock !== undefined && { stock: data.stock }),
          ...(data.availability !== undefined && { availability: data.availability }),
        },
      }),
    archive: async (id) => {
      await db.product.update({ where: { id }, data: { active: false } });
    },
    // Arquivar não apaga: restaurar é o caminho de volta para a vitrine.
    restore: async (id) => {
      await db.product.update({ where: { id }, data: { active: true } });
    },
    listByStoreCursor: async ({ storeId, limit, cursor, includeInactive }) => {
      const after = cursor ? afterCursorWhere(decodeCursor(cursor)) : {};
      const rows = await db.product.findMany({
        where: { storeId, ...(includeInactive ? {} : { active: true }), ...after },
        orderBy: [...KEYSET_ORDER_BY],
        take: limit + 1,
      });
      return toPage(
        rows,
        limit,
        (r) => ({ createdAt: r.createdAt, id: r.id }),
        (r) => r,
      );
    },
    findActiveBySlugs: (storeId, slugs) =>
      db.product.findMany({ where: { storeId, slug: { in: slugs }, active: true } }),
  };
}

export function toProductResponse(product: Product, publicUrl: (key: string) => string) {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    description: product.description,
    priceCents: product.priceCents,
    currency: product.currency,
    images: product.images,
    imageUrls: product.images.map(publicUrl),
    stock: product.stock,
    availability: product.availability,
    active: product.active,
    createdAt: product.createdAt.toISOString(),
  };
}
