import type { PrismaClient, Supplier } from "@prisma/client";
import {
  afterCursorWhere,
  type CursorPage,
  decodeCursor,
  KEYSET_ORDER_BY,
  toPage,
} from "../../../lib/cursor.js";
import { PAYOUT_ORDER_STATUSES } from "./payouts.helpers.js";
import type { CreateSupplierBody, UpdateSupplierBody } from "./payouts.schema.js";

/** Quanto cada parceiro gerou e quanto já recebeu, em centavos. */
export type PayoutTotals = { earnedCents: number; settledCents: number };

export type PayoutSale = {
  orderId: string;
  productName: string;
  qty: number;
  payoutCents: number;
  soldAt: Date;
  orderStatus: string;
};

export type PayoutSettlement = {
  id: string;
  amountCents: number;
  note: string | null;
  paidAt: Date;
  byName: string | null;
};

export interface PayoutsRepository {
  findSupplier(storeId: string, id: string): Promise<Supplier | null>;
  createSupplier(storeId: string, data: CreateSupplierBody): Promise<Supplier>;
  updateSupplier(id: string, data: UpdateSupplierBody): Promise<Supplier>;
  listSuppliersCursor(args: {
    storeId: string;
    limit: number;
    cursor: string | null;
    includeInactive: boolean;
  }): Promise<CursorPage<Supplier>>;
  /**
   * Todos os parceiros da loja, por nome. A tela de repasses precisa mostrar também
   * quem foi desativado mas ainda tem saldo em aberto.
   */
  listAllSuppliers(storeId: string, take: number): Promise<Supplier[]>;
  /** Soma por parceiro, para a loja inteira. Chave: supplierId. */
  totalsByStore(storeId: string): Promise<Map<string, PayoutTotals>>;
  totalsBySupplier(storeId: string, supplierId: string): Promise<PayoutTotals>;
  listSales(storeId: string, supplierId: string, take: number): Promise<PayoutSale[]>;
  listSettlements(supplierId: string, take: number): Promise<PayoutSettlement[]>;
  createSettlement(input: {
    storeId: string;
    supplierId: string;
    amountCents: number;
    note: string | null;
    paidAt: Date;
    createdById: string;
  }): Promise<{ id: string; paidAt: Date }>;
}

export function createPayoutsRepository(db: PrismaClient): PayoutsRepository {
  const earnedWhere = (storeId: string, supplierId?: string) => ({
    supplierId: supplierId ?? { not: null },
    order: { storeId, status: { in: PAYOUT_ORDER_STATUSES } },
  });

  return {
    findSupplier: (storeId, id) => db.supplier.findFirst({ where: { id, storeId } }),
    createSupplier: (storeId, data) =>
      db.supplier.create({
        data: {
          storeId,
          name: data.name,
          phone: data.phone ?? null,
          pixKey: data.pixKey ?? null,
          note: data.note ?? null,
        },
      }),
    updateSupplier: (id, data) =>
      db.supplier.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.phone !== undefined && { phone: data.phone }),
          ...(data.pixKey !== undefined && { pixKey: data.pixKey }),
          ...(data.note !== undefined && { note: data.note }),
          ...(data.active !== undefined && { active: data.active }),
        },
      }),
    listSuppliersCursor: async ({ storeId, limit, cursor, includeInactive }) => {
      const after = cursor ? afterCursorWhere(decodeCursor(cursor)) : {};
      const rows = await db.supplier.findMany({
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
    listAllSuppliers: (storeId, take) =>
      db.supplier.findMany({ where: { storeId }, orderBy: { name: "asc" }, take }),
    totalsByStore: async (storeId) => {
      const [earned, settled] = await Promise.all([
        db.orderItem.groupBy({
          by: ["supplierId"],
          where: earnedWhere(storeId),
          _sum: { payoutCents: true },
        }),
        db.supplierSettlement.groupBy({
          by: ["supplierId"],
          where: { storeId },
          _sum: { amountCents: true },
        }),
      ]);
      const map = new Map<string, PayoutTotals>();
      const bump = (id: string, patch: Partial<PayoutTotals>) => {
        const current = map.get(id) ?? { earnedCents: 0, settledCents: 0 };
        map.set(id, { ...current, ...patch });
      };
      for (const row of earned) {
        if (row.supplierId) bump(row.supplierId, { earnedCents: row._sum.payoutCents ?? 0 });
      }
      for (const row of settled) {
        bump(row.supplierId, { settledCents: row._sum.amountCents ?? 0 });
      }
      return map;
    },
    totalsBySupplier: async (storeId, supplierId) => {
      const [earned, settled] = await Promise.all([
        db.orderItem.aggregate({
          where: earnedWhere(storeId, supplierId),
          _sum: { payoutCents: true },
        }),
        db.supplierSettlement.aggregate({
          where: { storeId, supplierId },
          _sum: { amountCents: true },
        }),
      ]);
      return {
        earnedCents: earned._sum.payoutCents ?? 0,
        settledCents: settled._sum.amountCents ?? 0,
      };
    },
    listSales: async (storeId, supplierId, take) => {
      const rows = await db.orderItem.findMany({
        where: earnedWhere(storeId, supplierId),
        take,
        orderBy: [{ order: { createdAt: "desc" } }, { id: "desc" }],
        select: {
          orderId: true,
          name: true,
          qty: true,
          payoutCents: true,
          order: { select: { createdAt: true, status: true } },
        },
      });
      return rows.map((row) => ({
        orderId: row.orderId,
        productName: row.name,
        qty: row.qty,
        payoutCents: row.payoutCents,
        soldAt: row.order.createdAt,
        orderStatus: row.order.status,
      }));
    },
    listSettlements: async (supplierId, take) => {
      const rows = await db.supplierSettlement.findMany({
        where: { supplierId },
        take,
        orderBy: [{ paidAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          amountCents: true,
          note: true,
          paidAt: true,
          createdBy: { select: { name: true } },
        },
      });
      return rows.map((row) => ({
        id: row.id,
        amountCents: row.amountCents,
        note: row.note,
        paidAt: row.paidAt,
        byName: row.createdBy?.name ?? null,
      }));
    },
    createSettlement: async (input) => {
      const row = await db.supplierSettlement.create({
        data: {
          storeId: input.storeId,
          supplierId: input.supplierId,
          amountCents: input.amountCents,
          note: input.note,
          paidAt: input.paidAt,
          createdById: input.createdById,
        },
        select: { id: true, paidAt: true },
      });
      return row;
    },
  };
}

export function toSupplierResponse(supplier: Supplier) {
  return {
    id: supplier.id,
    name: supplier.name,
    phone: supplier.phone,
    pixKey: supplier.pixKey,
    note: supplier.note,
    active: supplier.active,
    createdAt: supplier.createdAt.toISOString(),
  };
}
