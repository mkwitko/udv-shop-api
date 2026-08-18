import type { Prisma, PrismaClient, Store, StoreRole, StoreStatus } from "@prisma/client";
import {
  afterCursorWhere,
  type CursorPage,
  decodeCursor,
  KEYSET_ORDER_BY,
  toPage,
} from "../../../lib/cursor.js";

export interface StoresRepository {
  findBySlug(slug: string): Promise<Store | null>;
  /** Só domínio já verificado resolve para a loja. */
  findByVerifiedDomain(domain: string): Promise<Store | null>;
  setCustomDomain(id: string, domain: string | null): Promise<Store>;
  markDomainVerified(id: string, verifiedAt: Date | null): Promise<Store>;
  createWithOwner(
    data: { slug: string; name: string; description?: string | null },
    ownerUserId: string,
  ): Promise<Store>;
  listActiveByCursor(limit: number, cursor: string | null): Promise<CursorPage<Store>>;
  listAllByCursor(
    limit: number,
    cursor: string | null,
    status: StoreStatus | undefined,
  ): Promise<CursorPage<Store>>;
  listByMember(userId: string): Promise<{ store: Store; role: StoreRole }[]>;
  update(
    id: string,
    data: {
      name?: string | undefined;
      description?: string | null | undefined;
      branding?: unknown;
    },
  ): Promise<Store>;
  setStatus(id: string, status: StoreStatus): Promise<Store>;
  attachStripeAccount(id: string, stripeAccountId: string): Promise<Store>;
  setStripeCapabilities(
    stripeAccountId: string,
    caps: { chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean },
  ): Promise<number>;
  setWooviConnect(id: string, input: { pixKey: string; subaccountId: string }): Promise<Store>;
}

export function createStoresRepository(db: PrismaClient): StoresRepository {
  return {
    findBySlug: (slug) => db.store.findUnique({ where: { slug } }),
    findByVerifiedDomain: (domain) =>
      db.store.findFirst({
        where: { customDomain: domain, customDomainVerifiedAt: { not: null } },
      }),
    // trocar o domínio zera a verificação: o CNAME do endereço novo ainda não foi visto
    setCustomDomain: (id, domain) =>
      db.store.update({
        where: { id },
        data: { customDomain: domain, customDomainVerifiedAt: null },
      }),
    markDomainVerified: (id, verifiedAt) =>
      db.store.update({ where: { id }, data: { customDomainVerifiedAt: verifiedAt } }),
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
    listAllByCursor: async (limit, cursor, status) => {
      const after = cursor ? afterCursorWhere(decodeCursor(cursor)) : {};
      const rows = await db.store.findMany({
        where: { ...(status ? { status } : {}), ...after },
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
    listByMember: async (userId) => {
      const rows = await db.userStoreRole.findMany({
        where: { userId },
        include: { store: true },
        orderBy: { store: { createdAt: "desc" } },
      });
      return rows.map((r) => ({ store: r.store, role: r.role }));
    },

    update: (id, data) => {
      const updateData: Prisma.StoreUpdateInput = {};
      if (data.name !== undefined) updateData.name = data.name;
      if (data.description !== undefined) updateData.description = data.description;
      if (data.branding !== undefined) updateData.branding = data.branding as Prisma.InputJsonValue;
      return db.store.update({ where: { id }, data: updateData });
    },
    setStatus: (id, status) => db.store.update({ where: { id }, data: { status } }),

    attachStripeAccount: (id, stripeAccountId) =>
      db.store.update({ where: { id }, data: { stripeAccountId } }),

    // Chaveado pelo id da conta conectada porque é só isso que o account.updated traz.
    // updateMany (e não update) para um evento de conta que não é nossa virar no-op em
    // vez de erro — o endpoint recebe eventos de todas as contas conectadas.
    setStripeCapabilities: async (stripeAccountId, caps) => {
      const updated = await db.store.updateMany({
        where: { stripeAccountId },
        data: {
          stripeChargesEnabled: caps.chargesEnabled,
          stripePayoutsEnabled: caps.payoutsEnabled,
          stripeDetailsSubmitted: caps.detailsSubmitted,
        },
      });
      return updated.count;
    },

    setWooviConnect: (id, input) =>
      db.store.update({
        where: { id },
        data: { wooviPixKey: input.pixKey, wooviSubaccountId: input.subaccountId },
      }),
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
