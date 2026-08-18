import type { Prisma, PrismaClient } from "@prisma/client";
import {
  afterCursorWhere,
  type CursorPage,
  decodeCursor,
  KEYSET_ORDER_BY,
  toPage,
} from "../../../lib/cursor.js";
import { normalizePayoutFields, unitPayoutCents } from "../payouts/payouts.helpers.js";
import type { CreateProductBody, UpdateProductBody } from "./products.schema.js";

// O nome do parceiro vem junto porque a tela de gestão mostra "quem recebe" ao lado
// do produto; a resposta pública descarta o bloco inteiro.
const PRODUCT_INCLUDE = {
  supplier: { select: { id: true, name: true } },
} satisfies Prisma.ProductInclude;

export type ProductWithSupplier = Prisma.ProductGetPayload<{ include: typeof PRODUCT_INCLUDE }>;

export interface ProductsRepository {
  findBySlug(storeId: string, slug: string): Promise<ProductWithSupplier | null>;
  create(storeId: string, data: CreateProductBody): Promise<ProductWithSupplier>;
  update(id: string, data: UpdateProductBody): Promise<ProductWithSupplier>;
  archive(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  listByStoreCursor(args: {
    storeId: string;
    limit: number;
    cursor: string | null;
    includeInactive: boolean;
  }): Promise<CursorPage<ProductWithSupplier>>;
  findActiveBySlugs(storeId: string, slugs: string[]): Promise<ProductWithSupplier[]>;
}

export function createProductsRepository(db: PrismaClient): ProductsRepository {
  return {
    findBySlug: (storeId, slug) =>
      db.product.findUnique({
        where: { storeId_slug: { storeId, slug } },
        include: PRODUCT_INCLUDE,
      }),
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
          ...normalizePayoutFields(data),
        },
        include: PRODUCT_INCLUDE,
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
          // o acordo de repasse só é reescrito quando o formulário manda os três campos
          ...(data.supplierId !== undefined ||
          data.payoutKind !== undefined ||
          data.payoutValue !== undefined
            ? normalizePayoutFields(data)
            : {}),
        },
        include: PRODUCT_INCLUDE,
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
        include: PRODUCT_INCLUDE,
      });
      return toPage(
        rows,
        limit,
        (r) => ({ createdAt: r.createdAt, id: r.id }),
        (r) => r,
      );
    },
    findActiveBySlugs: (storeId, slugs) =>
      db.product.findMany({
        where: { storeId, slug: { in: slugs }, active: true },
        include: PRODUCT_INCLUDE,
      }),
  };
}

export function toProductResponse(
  product: ProductWithSupplier,
  publicUrl: (key: string) => string,
  options: { payout?: boolean } = {},
) {
  const agreement =
    options.payout && product.supplier && product.payoutKind && product.payoutValue !== null
      ? {
          supplierId: product.supplier.id,
          supplierName: product.supplier.name,
          kind: product.payoutKind,
          value: product.payoutValue,
          unitCents: unitPayoutCents(product),
        }
      : null;

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
    payout: agreement,
  };
}
