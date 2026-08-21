import type { OrderStatus, Prisma, PrismaClient } from "@prisma/client";
import {
  afterCursorWhere,
  type CursorPage,
  decodeCursor,
  KEYSET_ORDER_BY,
  toPage,
} from "../../../lib/cursor.js";
import { ConflictError } from "../../../shared/errors.js";

// A refund claim ("refund_pending") that never gets confirmed by the provider's webhook
// (crash, dropped response, operator killing the process mid-request) would otherwise strand
// the payment forever: the controller's pre-check treats any refund_pending as "already
// refunding" and 409s every retry. Past this window we allow the claim to be retaken.
const STALE_REFUND_CLAIM_MS = 15 * 60_000;

const ORDER_INCLUDE = {
  items: true,
  payment: true,
  store: { select: { slug: true, name: true } },
} satisfies Prisma.OrderInclude;

export type OrderWithDetails = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

type NewOrderItem = {
  productId: string;
  name: string;
  priceCents: number;
  qty: number;
  supplierId: string | null;
  payoutCents: number;
};

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
    /** Chave do recibo público. Só vem preenchida quando o pedido nasce sem sessão. */
    publicToken: string | null;
    expiresAt: Date;
  }): Promise<OrderWithDetails>;
  attachProviderId(paymentId: string, providerId: string): Promise<void>;
  /**
   * Guarda a cobrança Pix para a tela de pagamento renascer depois de um F5 — sem isso o QR
   * code vive só na memória do navegador.
   */
  attachPixCharge(paymentId: string, pix: { brCode: string; qrCodeUrl: string }): Promise<void>;
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
  claimRefund(paymentId: string): Promise<boolean>;
  releaseRefundClaim(paymentId: string): Promise<void>;
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
  /**
   * Recibo de quem comprou sem conta. O token é um uuid v4 sorteado por pedido: quem não o tem
   * não acha o pedido, e ter o token não dá acesso a nada além dele.
   */
  findByPublicToken(id: string, token: string): Promise<OrderWithDetails | null>;
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
        const sortedItems = [...input.items].sort((a, b) =>
          a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
        );
        for (const item of sortedItems) {
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
            publicToken: input.publicToken,
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

    attachPixCharge: async (paymentId, pix) => {
      await db.payment.update({
        where: { id: paymentId },
        data: { pixBrCode: pix.brCode, pixQrCodeUrl: pix.qrCodeUrl },
      });
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
        // Widened on purpose (deviates from the plan's Step-3 block, see ADR-012):
        // a payment can legitimately still succeed after our TTL/cancel path already
        // moved it to expired/failed/cancelled (late 3DS, retried intent, Pix race).
        // Only "already succeeded/refunded" should be a no-op.
        const paid = await tx.payment.updateMany({
          where: { id: paymentId, status: { in: ["pending", "expired", "failed", "cancelled"] } },
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
        } else {
          // Money captured for an order that is no longer pending (already cancelled/
          // expired/refunded). Durable signal for manual reconciliation — the processor
          // also logs an error, but stdout is not queryable.
          await tx.outboxEvent.create({
            data: {
              type: "payment.orphaned",
              payload: { orderId: payment.orderId, paymentId: payment.id },
            },
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

    claimRefund: async (paymentId) => {
      // Single atomic updateMany: also re-claims a stale refund_pending (claimed but never
      // confirmed by the webhook). The write bumps updatedAt, which re-arms the staleness
      // window for the new claim.
      const claimed = await db.payment.updateMany({
        where: {
          id: paymentId,
          OR: [
            { status: "succeeded" },
            {
              status: "refund_pending",
              updatedAt: { lt: new Date(Date.now() - STALE_REFUND_CLAIM_MS) },
            },
          ],
        },
        data: { status: "refund_pending" },
      });
      return claimed.count === 1;
    },
    releaseRefundClaim: async (paymentId) => {
      await db.payment.updateMany({
        where: { id: paymentId, status: "refund_pending" },
        data: { status: "succeeded" },
      });
    },

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
    findByPublicToken: (id, token) =>
      db.order.findFirst({ where: { id, publicToken: token }, include: ORDER_INCLUDE }),
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
        take: 200,
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
    // "refund_pending" is the state left by the admin-triggered refund claim
    // (refund-order.controller.ts); "succeeded" covers a provider-initiated refund
    // that never went through our claim (defensive).
    const updated = await tx.payment.updateMany({
      where: { id: paymentId, status: { in: ["succeeded", "refund_pending"] } },
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
