import type { PrismaClient, Store } from "@prisma/client";

export interface StoresRepository {
  findBySlug(slug: string): Promise<Store | null>;
}

export function createStoresRepository(db: PrismaClient): StoresRepository {
  return {
    findBySlug: (slug) => db.store.findUnique({ where: { slug } }),
  };
}
