import type { Prisma, PrismaClient, ProductInterestStatus } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import {
  afterCursorWhere,
  type CursorPage,
  decodeCursor,
  KEYSET_ORDER_BY,
  toPage,
} from "../../../lib/cursor.js";
import { maskPhone } from "../../../lib/mask.js";
import { DEMAND_MAX_PRODUCTS } from "./interests.schema.js";

const INTEREST_INCLUDE = {
  product: {
    select: {
      id: true,
      slug: true,
      name: true,
      priceCents: true,
      availability: true,
      store: { select: { slug: true, name: true } },
    },
  },
  user: { select: { name: true, phone: true } },
} satisfies Prisma.ProductInterestInclude;

export type InterestWithDetails = Prisma.ProductInterestGetPayload<{
  include: typeof INTEREST_INCLUDE;
}>;

export interface InterestsRepository {
  upsertOpen(input: {
    productId: string;
    userId: string;
    qty: number;
    note: string | null;
  }): Promise<InterestWithDetails>;
  listMineCursor(args: {
    userId: string;
    status: ProductInterestStatus | null;
    limit: number;
    cursor: string | null;
  }): Promise<CursorPage<InterestWithDetails>>;
  findByIdForUser(id: string, userId: string): Promise<InterestWithDetails | null>;
  cancelMine(id: string, userId: string): Promise<boolean>;
  listByStoreCursor(args: {
    storeId: string;
    productId: string | null;
    status: ProductInterestStatus | null;
    limit: number;
    cursor: string | null;
  }): Promise<CursorPage<InterestWithDetails>>;
  aggregateDemand(storeId: string): Promise<
    Array<{
      product: { slug: string; name: string; priceCents: number; availability: string };
      openCount: number;
      notifiedCount: number;
      totalQty: number;
    }>
  >;
  notifyArrival(productId: string, log: FastifyBaseLogger): Promise<number>;
  convertForOrder(input: { userId: string; productIds: string[] }): Promise<number>;
}

export function createInterestsRepository(db: PrismaClient): InterestsRepository {
  return {
    upsertOpen: ({ productId, userId, qty, note }) =>
      db.productInterest.upsert({
        where: { productId_userId: { productId, userId } },
        // Reabre um interesse já notificado/convertido/cancelado em vez de criar linha
        // nova: o unique (productId, userId) é o que mantém a demanda agregada honesta.
        create: { productId, userId, qty, note },
        update: { qty, note, status: "open", notifiedAt: null },
        include: INTEREST_INCLUDE,
      }),

    listMineCursor: async ({ userId, status, limit, cursor }) => {
      const after = cursor ? afterCursorWhere(decodeCursor(cursor)) : {};
      const rows = await db.productInterest.findMany({
        where: { userId, ...(status !== null && { status }), ...after },
        orderBy: [...KEYSET_ORDER_BY],
        take: limit + 1,
        include: INTEREST_INCLUDE,
      });
      return toPage(
        rows,
        limit,
        (r) => ({ createdAt: r.createdAt, id: r.id }),
        (r) => r,
      );
    },

    findByIdForUser: (id, userId) =>
      db.productInterest.findFirst({ where: { id, userId }, include: INTEREST_INCLUDE }),

    cancelMine: async (id, userId) => {
      const cancelled = await db.productInterest.updateMany({
        where: { id, userId, status: { in: ["open", "notified"] } },
        data: { status: "cancelled" },
      });
      return cancelled.count === 1;
    },

    listByStoreCursor: async ({ storeId, productId, status, limit, cursor }) => {
      const after = cursor ? afterCursorWhere(decodeCursor(cursor)) : {};
      const rows = await db.productInterest.findMany({
        where: {
          product: { storeId },
          ...(productId !== null && { productId }),
          ...(status !== null && { status }),
          ...after,
        },
        orderBy: [...KEYSET_ORDER_BY],
        take: limit + 1,
        include: INTEREST_INCLUDE,
      });
      return toPage(
        rows,
        limit,
        (r) => ({ createdAt: r.createdAt, id: r.id }),
        (r) => r,
      );
    },

    aggregateDemand: async (storeId) => {
      // Só demanda viva: convertida já virou pedido, cancelada saiu da fila.
      const grouped = await db.productInterest.groupBy({
        by: ["productId", "status"],
        where: { product: { storeId }, status: { in: ["open", "notified"] } },
        _count: { _all: true },
        _sum: { qty: true },
      });
      if (grouped.length === 0) return [];
      const products = await db.product.findMany({
        where: { id: { in: [...new Set(grouped.map((g) => g.productId))] } },
        select: { id: true, slug: true, name: true, priceCents: true, availability: true },
      });
      const byId = new Map(products.map((p) => [p.id, p]));
      const acc = new Map<string, { openCount: number; notifiedCount: number; totalQty: number }>();
      for (const row of grouped) {
        const current = acc.get(row.productId) ?? { openCount: 0, notifiedCount: 0, totalQty: 0 };
        if (row.status === "open") current.openCount = row._count._all;
        if (row.status === "notified") current.notifiedCount = row._count._all;
        current.totalQty += row._sum.qty ?? 0;
        acc.set(row.productId, current);
      }
      // Teto é uma propriedade do agregado, não da resposta HTTP: o groupBy acima
      // ainda é ilimitado (conhecido — ver M2 na revisão), mas nada além do teto sai
      // do repositório.
      return [...acc.entries()]
        .flatMap(([productId, counts]) => {
          const product = byId.get(productId);
          return product
            ? [
                {
                  product: {
                    slug: product.slug,
                    name: product.name,
                    priceCents: product.priceCents,
                    availability: product.availability as string,
                  },
                  ...counts,
                },
              ]
            : [];
        })
        .sort((a, b) => b.totalQty - a.totalQty || a.product.slug.localeCompare(b.product.slug))
        .slice(0, DEMAND_MAX_PRODUCTS);
    },

    notifyArrival: (productId, log) =>
      db.$transaction(async (tx) => {
        const notifiedAt = new Date();
        // Teto por chamada: a loja pode chamar de novo para drenar o resto, e cada
        // interesse já notificado sai do conjunto "open".
        const rows = await tx.productInterest.findMany({
          where: { productId, status: "open" },
          select: { id: true },
          take: 500,
        });
        if (rows.length === 0) return 0;
        const ids = rows.map((r) => r.id);
        const updated = await tx.productInterest.updateMany({
          where: { id: { in: ids }, status: "open" },
          data: { status: "notified", notifiedAt },
        });
        // Deriva os eventos do que o updateMany realmente escreveu, não da pré-seleção:
        // um cancelamento concorrente entre o findMany e o updateMany tira a linha do
        // conjunto "notified" e ela não deve gerar email nem contar como enfileirada.
        const notifiedRows = await tx.productInterest.findMany({
          where: { id: { in: ids }, status: "notified", notifiedAt },
          select: { id: true },
        });
        // Email nunca sai inline no request da loja: o outbox garante entrega e retry.
        await tx.outboxEvent.createMany({
          data: notifiedRows.map((r) => ({
            type: "interest.notified",
            payload: { interestId: r.id },
          })),
        });
        if (rows.length === 500) {
          log.warn(
            { productId },
            "notifyArrival: teto de 500 encomendas atingido nesta chamada, chame de novo para drenar o resto",
          );
        }
        return updated.count;
      }),

    convertForOrder: async ({ userId, productIds }) => {
      if (productIds.length === 0) return 0;
      // updateMany guardado por status: reprocessar o mesmo order.paid é no-op, e
      // interesse cancelado/já convertido não é tocado.
      const converted = await db.productInterest.updateMany({
        where: { userId, productId: { in: productIds }, status: { in: ["open", "notified"] } },
        data: { status: "converted" },
      });
      return converted.count;
    },
  };
}

/** Resposta da fila da loja: identidade suficiente para agir, contato mascarado. */
export function toStoreInterestResponse(interest: InterestWithDetails) {
  return {
    ...toInterestResponse(interest),
    customer: {
      name: interest.user.name,
      phoneMasked: maskPhone(interest.user.phone),
    },
  };
}

export function toInterestResponse(interest: InterestWithDetails) {
  return {
    id: interest.id,
    store: { slug: interest.product.store.slug, name: interest.product.store.name },
    product: {
      slug: interest.product.slug,
      name: interest.product.name,
      priceCents: interest.product.priceCents,
      availability: interest.product.availability,
    },
    qty: interest.qty,
    status: interest.status,
    note: interest.note,
    notifiedAt: interest.notifiedAt?.toISOString() ?? null,
    createdAt: interest.createdAt.toISOString(),
  };
}
