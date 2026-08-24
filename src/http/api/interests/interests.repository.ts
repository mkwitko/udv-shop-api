import type { InterestStatus, Prisma, PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import {
  afterCursorWhere,
  type CursorPage,
  decodeCursor,
  KEYSET_ORDER_BY,
  toPage,
} from "../../../lib/cursor.js";
import { maskPhone } from "../../../lib/mask.js";
import { DEMAND_MAX_SUBJECTS } from "./interests.schema.js";

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
  event: {
    select: {
      id: true,
      slug: true,
      name: true,
      priceCents: true,
      at: true,
      location: true,
      store: { select: { slug: true, name: true } },
    },
  },
  user: { select: { name: true, phone: true } },
} satisfies Prisma.InterestInclude;

export type InterestWithDetails = Prisma.InterestGetPayload<{
  include: typeof INTEREST_INCLUDE;
}>;

/** O alvo da espera: produto esgotado ou evento lotado. Sempre um, nunca os dois. */
export type InterestTarget = { productId: string } | { eventId: string };

function targetWhere(target: InterestTarget): Prisma.InterestWhereInput {
  return "productId" in target ? { productId: target.productId } : { eventId: target.eventId };
}

export interface InterestsRepository {
  upsertOpen(
    input: InterestTarget & {
      userId: string;
      qty: number;
      note: string | null;
    },
  ): Promise<InterestWithDetails>;
  listMineCursor(args: {
    userId: string;
    status: InterestStatus | null;
    limit: number;
    cursor: string | null;
  }): Promise<CursorPage<InterestWithDetails>>;
  findByIdForUser(id: string, userId: string): Promise<InterestWithDetails | null>;
  cancelMine(id: string, userId: string): Promise<boolean>;
  listByStoreCursor(args: {
    storeId: string;
    target: InterestTarget | null;
    status: InterestStatus | null;
    limit: number;
    cursor: string | null;
  }): Promise<CursorPage<InterestWithDetails>>;
  aggregateDemand(storeId: string): Promise<
    Array<{
      kind: "produto" | "evento";
      product: { slug: string; name: string; priceCents: number; availability: string } | null;
      event: {
        slug: string;
        name: string;
        priceCents: number;
        at: string;
        location: string | null;
      } | null;
      openCount: number;
      notifiedCount: number;
      totalQty: number;
    }>
  >;
  notifyArrival(target: InterestTarget, log: FastifyBaseLogger): Promise<number>;
  /** Fecha a fila de quem comprou. Produtos e eventos do mesmo pedido, de uma vez. */
  convertForOrder(input: {
    userId: string;
    productIds: string[];
    eventIds: string[];
  }): Promise<number>;
}

export function createInterestsRepository(db: PrismaClient): InterestsRepository {
  return {
    upsertOpen: ({ userId, qty, note, ...target }) =>
      db.interest.upsert({
        // Reabre um interesse já notificado/convertido/cancelado em vez de criar linha
        // nova: o unique (alvo, pessoa) é o que mantém a demanda agregada honesta.
        where:
          "productId" in target
            ? { productId_userId: { productId: target.productId, userId } }
            : { eventId_userId: { eventId: target.eventId, userId } },
        create: { ...target, userId, qty, note },
        update: { qty, note, status: "open", notifiedAt: null },
        include: INTEREST_INCLUDE,
      }),

    listMineCursor: async ({ userId, status, limit, cursor }) => {
      const after = cursor ? afterCursorWhere(decodeCursor(cursor)) : {};
      const rows = await db.interest.findMany({
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
      db.interest.findFirst({ where: { id, userId }, include: INTEREST_INCLUDE }),

    cancelMine: async (id, userId) => {
      const cancelled = await db.interest.updateMany({
        where: { id, userId, status: { in: ["open", "notified"] } },
        data: { status: "cancelled" },
      });
      return cancelled.count === 1;
    },

    listByStoreCursor: async ({ storeId, target, status, limit, cursor }) => {
      const after = cursor ? afterCursorWhere(decodeCursor(cursor)) : {};
      const rows = await db.interest.findMany({
        where: {
          // a loja do interesse é a do alvo, e o alvo pode ser dos dois tipos
          OR: [{ product: { storeId } }, { event: { storeId } }],
          ...(target !== null && targetWhere(target)),
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
      const live = { status: { in: ["open" as const, "notified" as const] } };
      const [byProduct, byEvent] = await Promise.all([
        db.interest.groupBy({
          by: ["productId", "status"],
          where: { product: { storeId }, ...live },
          _count: { _all: true },
          _sum: { qty: true },
        }),
        db.interest.groupBy({
          by: ["eventId", "status"],
          where: { event: { storeId }, ...live },
          _count: { _all: true },
          _sum: { qty: true },
        }),
      ]);
      if (byProduct.length === 0 && byEvent.length === 0) return [];

      const [products, events] = await Promise.all([
        db.product.findMany({
          where: {
            id: { in: [...new Set(byProduct.flatMap((g) => (g.productId ? [g.productId] : [])))] },
          },
          select: { id: true, slug: true, name: true, priceCents: true, availability: true },
        }),
        db.event.findMany({
          where: {
            id: { in: [...new Set(byEvent.flatMap((g) => (g.eventId ? [g.eventId] : [])))] },
          },
          select: { id: true, slug: true, name: true, priceCents: true, at: true, location: true },
        }),
      ]);

      type Counts = { openCount: number; notifiedCount: number; totalQty: number };
      const acc = new Map<string, Counts>();
      const soma = (id: string | null, status: string, count: number, qty: number | null) => {
        if (!id) return;
        const current = acc.get(id) ?? { openCount: 0, notifiedCount: 0, totalQty: 0 };
        if (status === "open") current.openCount = count;
        if (status === "notified") current.notifiedCount = count;
        current.totalQty += qty ?? 0;
        acc.set(id, current);
      };
      for (const row of byProduct) soma(row.productId, row.status, row._count._all, row._sum.qty);
      for (const row of byEvent) soma(row.eventId, row.status, row._count._all, row._sum.qty);

      const zero: Counts = { openCount: 0, notifiedCount: 0, totalQty: 0 };
      const items = [
        ...products.map((product) => ({
          kind: "produto" as const,
          product: {
            slug: product.slug,
            name: product.name,
            priceCents: product.priceCents,
            availability: product.availability as string,
          },
          event: null,
          ...(acc.get(product.id) ?? zero),
        })),
        ...events.map((event) => ({
          kind: "evento" as const,
          product: null,
          event: {
            slug: event.slug,
            name: event.name,
            priceCents: event.priceCents,
            at: event.at.toISOString(),
            location: event.location,
          },
          ...(acc.get(event.id) ?? zero),
        })),
      ];

      // Teto é uma propriedade do agregado, não da resposta HTTP: os groupBy acima ainda
      // são ilimitados (conhecido — ver M2 na revisão), mas nada além do teto sai daqui.
      return items
        .sort(
          (a, b) =>
            b.totalQty - a.totalQty ||
            (a.product?.slug ?? a.event?.slug ?? "").localeCompare(
              b.product?.slug ?? b.event?.slug ?? "",
            ),
        )
        .slice(0, DEMAND_MAX_SUBJECTS);
    },

    notifyArrival: (target, log) =>
      db.$transaction(async (tx) => {
        const notifiedAt = new Date();
        const where = targetWhere(target);
        // Teto por chamada: a loja pode chamar de novo para drenar o resto, e cada
        // interesse já notificado sai do conjunto "open".
        const rows = await tx.interest.findMany({
          where: { ...where, status: "open" },
          select: { id: true },
          take: 500,
        });
        if (rows.length === 0) return 0;
        const ids = rows.map((r) => r.id);
        const updated = await tx.interest.updateMany({
          where: { id: { in: ids }, status: "open" },
          data: { status: "notified", notifiedAt },
        });
        // Deriva os eventos do que o updateMany realmente escreveu, não da pré-seleção:
        // um cancelamento concorrente entre o findMany e o updateMany tira a linha do
        // conjunto "notified" e ela não deve gerar email nem contar como enfileirada.
        const notifiedRows = await tx.interest.findMany({
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
            where,
            "notifyArrival: teto de 500 na fila nesta chamada, chame de novo para drenar o resto",
          );
        }
        return updated.count;
      }),

    convertForOrder: async ({ userId, productIds, eventIds }) => {
      if (productIds.length === 0 && eventIds.length === 0) return 0;
      // updateMany guardado por status: reprocessar o mesmo order.paid é no-op, e
      // interesse cancelado/já convertido não é tocado.
      const converted = await db.interest.updateMany({
        where: {
          userId,
          status: { in: ["open", "notified"] },
          OR: [
            ...(productIds.length > 0 ? [{ productId: { in: productIds } }] : []),
            ...(eventIds.length > 0 ? [{ eventId: { in: eventIds } }] : []),
          ],
        },
        data: { status: "converted" },
      });
      return converted.count;
    },
  };
}

/**
 * Resposta da fila da loja: identidade suficiente para agir, contato mascarado. O número
 * inteiro só vai quando quem pediu responde pela loja — é essa pessoa que avisa por WhatsApp
 * quem deixou só telefone.
 */
export function toStoreInterestResponse(interest: InterestWithDetails, revealPhone: boolean) {
  return {
    ...toInterestResponse(interest),
    customer: {
      name: interest.user.name,
      phoneMasked: maskPhone(interest.user.phone),
      phone: revealPhone ? interest.user.phone : null,
    },
  };
}

export function toInterestResponse(interest: InterestWithDetails) {
  // O CHECK do banco garante um alvo e só um, então o `event` manda quando existe.
  const store = interest.product?.store ?? interest.event?.store;
  return {
    id: interest.id,
    store: { slug: store?.slug ?? "", name: store?.name ?? "" },
    kind: interest.event ? ("evento" as const) : ("produto" as const),
    product: interest.product
      ? {
          slug: interest.product.slug,
          name: interest.product.name,
          priceCents: interest.product.priceCents,
          availability: interest.product.availability as string,
        }
      : null,
    event: interest.event
      ? {
          slug: interest.event.slug,
          name: interest.event.name,
          priceCents: interest.event.priceCents,
          at: interest.event.at.toISOString(),
          location: interest.event.location,
        }
      : null,
    qty: interest.qty,
    status: interest.status,
    note: interest.note,
    notifiedAt: interest.notifiedAt?.toISOString() ?? null,
    createdAt: interest.createdAt.toISOString(),
  };
}
