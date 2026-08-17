import type { Prisma, PrismaClient, Store, StoreStatus } from "@prisma/client";
import {
  afterCursorWhere,
  type CursorPage,
  decodeCursor,
  KEYSET_ORDER_BY,
  toPage,
} from "../../../lib/cursor.js";

export interface StoresRepository {
  findBySlug(slug: string): Promise<Store | null>;
  createWithOwner(
    data: { slug: string; name: string; description?: string | null },
    ownerUserId: string,
  ): Promise<Store>;
  listActiveByCursor(limit: number, cursor: string | null): Promise<CursorPage<Store>>;
  update(
    id: string,
    data: Partial<{ name: string; description: string | null; branding: unknown }>,
  ): Promise<Store>;
  setStatus(id: string, status: StoreStatus): Promise<Store>;
}

export function createStoresRepository(db: PrismaClient): StoresRepository {
  return {
    findBySlug: (slug) => db.store.findUnique({ where: { slug } }),
    createWithOwner: (data, ownerUserId) =>
      db.$transaction(async (tx) => {
        const store = await tx.store.create({
          data: { slug: data.slug, name: data.name, description: data.description ?? null },
        });
        await tx.userStoreRole.create({
          data: { userId: ownerUserId, storeId: store.id, role: "owner" },
        });
        return store;
      }),
    listActiveByCursor: async (limit, cursor) => {
      const after = cursor ? afterCursorWhere(decodeCursor(cursor)) : {};
      const rows = await db.store.findMany({
        where: { status: "active", ...after },
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
    update: (id, data) => {
      const updateData: Prisma.StoreUpdateInput = {};
      if (data.name !== undefined) updateData.name = data.name;
      if (data.description !== undefined) updateData.description = data.description;
      if (data.branding !== undefined) updateData.branding = data.branding as Prisma.InputJsonValue;
      return db.store.update({ where: { id }, data: updateData });
    },
    setStatus: (id, status) => db.store.update({ where: { id }, data: { status } }),
  };
}

export function toStoreResponse(store: Store) {
  return {
    id: store.id,
    slug: store.slug,
    name: store.name,
    description: store.description,
    status: store.status,
    branding: store.branding ?? null,
    createdAt: store.createdAt.toISOString(),
  };
}
