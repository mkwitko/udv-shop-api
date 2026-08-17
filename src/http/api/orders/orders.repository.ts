import type { OrderStatus, Prisma, PrismaClient } from "@prisma/client";
import {
  afterCursorWhere,
  type CursorPage,
  decodeCursor,
  KEYSET_ORDER_BY,
  toPage,
} from "../../../lib/cursor.js";
import { ConflictError } from "../../../shared/errors.js";

const ORDER_INCLUDE = {
  items: true,
  payment: true,
  store: { select: { slug: true, name: true } },
} satisfies Prisma.OrderInclude;

export type OrderWithDetails = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

type NewOrderItem = { productId: string; name: string; priceCents: number; qty: number };

export interface OrdersRepository {
  createPendingOrder(input: {
    storeId: string;
    userId: string;
    provider: "stripe" | "woovi";
    items: NewOrderItem[];
    totalCents: number;
    applicationFeeCents: number;
    contactPhone: string;
    note: string | null;
    expiresAt: Date;
  }): Promise<OrderWithDetails>;
  attachProviderId(paymentId: string, providerId: string): Promise<void>;
  compensateFailedCheckout(orderId: string): Promise<void>;
  markPaid(
    paymentId: string,
    providerId: string | null,
  ): Promise<{ orderId: string; orderWasPending: boolean } | null>;
  cancelPendingOrder(
    orderId: string,
    paymentStatus: "expired" | "failed" | "cancelled",
  ): Promise<boolean>;
  markRefundedByProviderId(providerId: string): Promise<boolean>;
  markRefundedByPaymentId(paymentId: string): Promise<boolean>;
  listMineCursor(args: {
    userId: string;
    limit: number;
    cursor: string | null;
  }): Promise<CursorPage<OrderWithDetails>>;
  listByStoreCursor(args: {
    storeId: string;
    status: OrderStatus | null;
    limit: number;
    cursor: string | null;
  }): Promise<CursorPage<OrderWithDetails>>;
  findByIdForUser(id: string, userId: string): Promise<OrderWithDetails | null>;
  findByIdForStore(id: string, storeId: string): Promise<OrderWithDetails | null>;
  updateOrderStatus(id: string, from: OrderStatus[], to: OrderStatus): Promise<boolean>;
  listExpiredPending(now: Date): Promise<Array<{ id: string }>>;
  findPaymentByOrderId(orderId: string): Promise<{
    id: string;
    provider: "stripe" | "woovi";
    providerId: string | null;
    status: string;
  } | null>;
}

async function restockItems(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  const items = await tx.orderItem.findMany({ where: { orderId } });
  for (const item of items) {
    await tx.product.update({
      where: { id: item.productId },
      data: { stock: { increment: item.qty } },
    });
  }
}

export function createOrdersRepository(db: PrismaClient): OrdersRepository {
  return {
    createPendingOrder: (input) =>
      db.$transaction(async (tx) => {
        for (const item of input.items) {
          const updated = await tx.product.updateMany({
            where: { id: item.productId, stock: { gte: item.qty } },
            data: { stock: { decrement: item.qty } },
          });
          if (updated.count !== 1) throw new ConflictError("insufficient_stock");
        }
        return tx.order.create({
          data: {
            storeId: input.storeId,
            userId: input.userId,
            totalCents: input.totalCents,
            contactPhone: input.contactPhone,
            note: input.note,
            expiresAt: input.expiresAt,
            items: { create: input.items },
            payment: {
              create: {
                provider: input.provider,
                amountCents: input.totalCents,
                applicationFeeCents: input.applicationFeeCents,
              },
            },
          },
          include: ORDER_INCLUDE,
        });
      }),

    attachProviderId: async (paymentId, providerId) => {
      await db.payment.update({ where: { id: paymentId }, data: { providerId } });
    },

    compensateFailedCheckout: async (orderId) => {
      await db.$transaction(async (tx) => {
        const cancelled = await tx.order.updateMany({
          where: { id: orderId, status: "pending_payment" },
          data: { status: "cancelled" },
        });
        if (cancelled.count !== 1) return;
        await restockItems(tx, orderId);
        await tx.payment.updateMany({
          where: { orderId, status: "pending" },
          data: { status: "failed" },
        });
      });
    },

    markPaid: (paymentId, providerId) =>
      db.$transaction(async (tx) => {
        const paid = await tx.payment.updateMany({
          where: { id: paymentId, status: "pending" },
          data: { status: "succeeded", ...(providerId !== null && { providerId }) },
        });
        if (paid.count !== 1) return null;
        const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
        if (!payment.orderId) return null;
        const transitioned = await tx.order.updateMany({
          where: { id: payment.orderId, status: "pending_payment" },
          data: { status: "paid" },
        });
        const orderWasPending = transitioned.count === 1;
        if (orderWasPending) {
          await tx.outboxEvent.create({
            data: { type: "order.paid", payload: { orderId: payment.orderId } },
          });
        }
        return { orderId: payment.orderId, orderWasPending };
      }),

    cancelPendingOrder: (orderId, paymentStatus) =>
      db.$transaction(async (tx) => {
        const cancelled = await tx.order.updateMany({
          where: { id: orderId, status: "pending_payment" },
          data: { status: "cancelled" },
        });
        if (cancelled.count !== 1) return false;
        await restockItems(tx, orderId);
        await tx.payment.updateMany({
          where: { orderId, status: "pending" },
          data: { status: paymentStatus },
        });
        return true;
      }),

    markRefundedByProviderId: async (providerId) => {
      const payment = await db.payment.findFirst({ where: { providerId } });
      if (!payment) return false;
      return refund(db, payment.id);
    },
    markRefundedByPaymentId: (paymentId) => refund(db, paymentId),

    listMineCursor: async ({ userId, limit, cursor }) => {
      const after = cursor ? afterCursorWhere(decodeCursor(cursor)) : {};
      const rows = await db.order.findMany({
        where: { userId, ...after },
        orderBy: [...KEYSET_ORDER_BY],
        take: limit + 1,
        include: ORDER_INCLUDE,
      });
      return toPage(
        rows,
        limit,
        (r) => ({ createdAt: r.createdAt, id: r.id }),
        (r) => r,
      );
    },

    listByStoreCursor: async ({ storeId, status, limit, cursor }) => {
      const after = cursor ? afterCursorWhere(decodeCursor(cursor)) : {};
      const rows = await db.order.findMany({
        where: { storeId, ...(status !== null && { status }), ...after },
        orderBy: [...KEYSET_ORDER_BY],
        take: limit + 1,
        include: ORDER_INCLUDE,
      });
      return toPage(
        rows,
        limit,
        (r) => ({ createdAt: r.createdAt, id: r.id }),
        (r) => r,
      );
    },

    findByIdForUser: (id, userId) =>
      db.order.findFirst({ where: { id, userId }, include: ORDER_INCLUDE }),
    findByIdForStore: (id, storeId) =>
      db.order.findFirst({ where: { id, storeId }, include: ORDER_INCLUDE }),

    updateOrderStatus: async (id, from, to) => {
      const updated = await db.order.updateMany({
        where: { id, status: { in: from } },
        data: { status: to },
      });
      return updated.count === 1;
    },

    listExpiredPending: (now) =>
      db.order.findMany({
        where: { status: "pending_payment", expiresAt: { lt: now } },
        select: { id: true },
      }),

    findPaymentByOrderId: async (orderId) => {
      const p = await db.payment.findUnique({ where: { orderId } });
      return p
        ? { id: p.id, provider: p.provider, providerId: p.providerId, status: p.status }
        : null;
    },
  };
}

async function refund(db: PrismaClient, paymentId: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const updated = await tx.payment.updateMany({
      where: { id: paymentId, status: "succeeded" },
      data: { status: "refunded" },
    });
    if (updated.count !== 1) return false;
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if (payment.orderId) {
      await tx.order.updateMany({
        where: { id: payment.orderId, status: { in: ["paid", "delivery_arranged", "delivered"] } },
        data: { status: "refunded" },
      });
    }
    return true;
  });
}

export function toOrderResponse(order: OrderWithDetails) {
  return {
    id: order.id,
    store: { slug: order.store.slug, name: order.store.name },
    status: order.status,
    totalCents: order.totalCents,
    currency: order.currency,
    contactPhone: order.contactPhone,
    note: order.note,
    expiresAt: order.expiresAt.toISOString(),
    createdAt: order.createdAt.toISOString(),
    items: order.items.map((i) => ({
      productId: i.productId,
      name: i.name,
      priceCents: i.priceCents,
      qty: i.qty,
    })),
    payment: order.payment
      ? { provider: order.payment.provider, status: order.payment.status }
      : null,
  };
}
