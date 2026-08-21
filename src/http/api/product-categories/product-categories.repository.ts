import type { PrismaClient, ProductCategory } from "@prisma/client";
import { uniqueSlug } from "../../../lib/slug.js";
import { NotFoundError, ValidationError } from "../../../shared/errors.js";

export type CategoryWithCount = ProductCategory & { productCount: number };

export interface ProductCategoriesRepository {
  listByStore(storeId: string): Promise<{ items: CategoryWithCount[]; total: number }>;
  create(storeId: string, name: string): Promise<ProductCategory>;
  rename(storeId: string, id: string, name: string): Promise<ProductCategory>;
  reorder(storeId: string, ids: string[]): Promise<void>;
  remove(storeId: string, id: string): Promise<void>;
  findInStore(storeId: string, id: string): Promise<ProductCategory | null>;
  findBySlug(storeId: string, slug: string): Promise<ProductCategory | null>;
}

/**
 * Toda operação leva `storeId` na cláusula, nunca só o id da categoria: id é dado que
 * chega do cliente, e a loja autorizada é a que a rota resolveu. Categoria de outra
 * loja simplesmente não é encontrada aqui.
 */
export function createProductCategoriesRepository(db: PrismaClient): ProductCategoriesRepository {
  async function takenSlugs(storeId: string, exceptId?: string): Promise<Set<string>> {
    const rows = await db.productCategory.findMany({
      where: { storeId, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { slug: true },
    });
    return new Set(rows.map((row) => row.slug));
  }

  return {
    // contagem por groupBy: uma query para todas as categorias, em vez de uma por gaveta
    listByStore: async (storeId) => {
      const [categories, counts, total] = await Promise.all([
        db.productCategory.findMany({
          where: { storeId },
          orderBy: [{ position: "asc" }, { name: "asc" }],
        }),
        db.product.groupBy({
          by: ["categoryId"],
          where: { storeId, active: true, categoryId: { not: null } },
          _count: { _all: true },
        }),
        db.product.count({ where: { storeId, active: true } }),
      ]);
      const byId = new Map(counts.map((row) => [row.categoryId, row._count._all]));
      return {
        items: categories.map((category) => ({
          ...category,
          productCount: byId.get(category.id) ?? 0,
        })),
        total,
      };
    },

    create: async (storeId, name) => {
      const [taken, last] = await Promise.all([
        takenSlugs(storeId),
        db.productCategory.findFirst({ where: { storeId }, orderBy: { position: "desc" } }),
      ]);
      return db.productCategory.create({
        data: {
          storeId,
          name,
          slug: uniqueSlug(name, taken),
          position: last ? last.position + 1 : 0,
        },
      });
    },

    rename: async (storeId, id, name) => {
      const current = await db.productCategory.findFirst({ where: { id, storeId } });
      if (!current) throw new NotFoundError("category_not_found");
      const taken = await takenSlugs(storeId, id);
      return db.productCategory.update({
        where: { id: current.id },
        data: { name, slug: uniqueSlug(name, taken) },
      });
    },

    // a ordem inteira numa transação: metade aplicada deixaria a vitrine embaralhada
    reorder: async (storeId, ids) => {
      const owned = await db.productCategory.findMany({
        where: { storeId, id: { in: ids } },
        select: { id: true },
      });
      if (owned.length !== ids.length || new Set(ids).size !== ids.length) {
        throw new ValidationError("invalid_category_order");
      }
      await db.$transaction(
        ids.map((id, position) => db.productCategory.update({ where: { id }, data: { position } })),
      );
    },

    remove: async (storeId, id) => {
      const current = await db.productCategory.findFirst({ where: { id, storeId } });
      if (!current) throw new NotFoundError("category_not_found");
      // produto não é apagado: o FK é SetNull e ele volta para "sem categoria"
      await db.productCategory.delete({ where: { id: current.id } });
    },

    findInStore: (storeId, id) => db.productCategory.findFirst({ where: { id, storeId } }),
    findBySlug: (storeId, slug) => db.productCategory.findFirst({ where: { storeId, slug } }),
  };
}

export function toCategoryResponse(category: CategoryWithCount) {
  return {
    id: category.id,
    slug: category.slug,
    name: category.name,
    position: category.position,
    productCount: category.productCount,
  };
}

/** Resposta de escrita: quem acabou de criar/renomear não precisa da contagem. */
export function toCategoryWriteResponse(category: ProductCategory, productCount = 0) {
  return toCategoryResponse({ ...category, productCount });
}
