import type { Prisma, PrismaClient } from "@prisma/client";
import {
  afterCursorWhere,
  afterPriceCursorWhere,
  type CursorPage,
  decodeCursor,
  decodePriceCursor,
  encodeCursor,
  encodePriceCursor,
  KEYSET_ORDER_BY,
  priceOrderBy,
  toPageBy,
} from "../../../lib/cursor.js";
import { normalizePayoutFields, unitPayoutCents } from "../payouts/payouts.helpers.js";
import type { CreateProductBody, ProductSort, UpdateProductBody } from "./products.schema.js";

// O nome do parceiro vem junto porque a tela de gestão mostra "quem recebe" ao lado
// do produto; a resposta pública descarta o bloco inteiro. A categoria vem sempre:
// é rótulo da vitrine, não acordo interno.
const PRODUCT_INCLUDE = {
  supplier: { select: { id: true, name: true } },
  category: { select: { id: true, slug: true, name: true } },
} satisfies Prisma.ProductInclude;

/**
 * `contains` do Prisma não escapa `%` e `_`, então um termo de curinga viraria "traga
 * tudo". Tirar os curingas é o comportamento honesto: quem digitou só `%` não buscou nada.
 */
export function sanitizeSearch(term: string): string {
  return term.replace(/[%_\\]/g, "").trim();
}

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
    /** id já resolvido a partir do slug pela rota — o cliente nunca manda id aqui. */
    categoryId?: string | undefined;
    search?: string | undefined;
    sort?: ProductSort | undefined;
    /** "produto" esconde ingresso de evento; "evento" mostra só ingresso. */
    kind?: "produto" | "evento" | "todos" | undefined;
  }): Promise<CursorPage<ProductWithSupplier>>;
  findActiveBySlugs(storeId: string, slugs: string[]): Promise<ProductWithSupplier[]>;
  /**
   * Agenda da loja: eventos que ainda vão acontecer, do mais próximo ao mais distante.
   * Sem cursor de propósito — agenda de núcleo tem dezenas de linhas, não milhares, e
   * paginar por data pediria um cursor novo só para isso.
   */
  listUpcomingEvents(storeId: string, limit: number): Promise<ProductWithSupplier[]>;
}

/**
 * Data e lugar do evento, prontos para o Prisma. Campo ausente não é tocado; `null` limpa
 * — apagar a data devolve o ingresso para a vitrine como produto comum, e é assim que a
 * loja desfaz um evento criado por engano.
 */
function eventFields(data: {
  eventAt?: string | null | undefined;
  eventEndsAt?: string | null | undefined;
  eventLocation?: string | null | undefined;
}) {
  return {
    ...(data.eventAt !== undefined && { eventAt: data.eventAt ? new Date(data.eventAt) : null }),
    ...(data.eventEndsAt !== undefined && {
      eventEndsAt: data.eventEndsAt ? new Date(data.eventEndsAt) : null,
    }),
    ...(data.eventLocation !== undefined && { eventLocation: data.eventLocation || null }),
  };
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
          categoryId: data.categoryId ?? null,
          ...eventFields(data),
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
          ...(data.categoryId !== undefined && { categoryId: data.categoryId }),
          ...eventFields(data),
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
    listByStoreCursor: async ({
      storeId,
      limit,
      cursor,
      includeInactive,
      categoryId,
      search,
      sort = "recent",
      kind = "produto",
    }) => {
      const term = search ? sanitizeSearch(search) : "";
      // termo que era só curinga não pode virar "traga tudo": não achou nada, e ponto
      if (search && !term) return { items: [], nextCursor: null };
      const filters: Prisma.ProductWhereInput = {
        storeId,
        ...(includeInactive ? {} : { active: true }),
        ...(kind === "produto"
          ? { eventAt: null }
          : kind === "evento"
            ? { eventAt: { not: null } }
            : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: "insensitive" } },
                { description: { contains: term, mode: "insensitive" } },
              ],
            }
          : {}),
      };

      if (sort === "recent") {
        const rows = await db.product.findMany({
          where: { ...filters, ...(cursor ? afterCursorWhere(decodeCursor(cursor)) : {}) },
          orderBy: [...KEYSET_ORDER_BY],
          take: limit + 1,
          include: PRODUCT_INCLUDE,
        });
        return toPageBy(
          rows,
          limit,
          (r) => encodeCursor(r.createdAt, r.id),
          (r) => r,
        );
      }

      // preço tem cursor próprio (preço + id): com o cursor de data a página pularia
      // e repetiria produto sempre que dois preços não estivessem na mesma ordem das datas
      const direction = sort === "price_asc" ? "asc" : "desc";
      const rows = await db.product.findMany({
        where: {
          ...filters,
          ...(cursor ? afterPriceCursorWhere(decodePriceCursor(cursor), direction) : {}),
        },
        orderBy: [...priceOrderBy(direction)],
        take: limit + 1,
        include: PRODUCT_INCLUDE,
      });
      return toPageBy(
        rows,
        limit,
        (r) => encodePriceCursor(r.priceCents, r.id),
        (r) => r,
      );
    },
    // O corte é pelo FIM do evento quando ele existe: uma sessão que começou às 20h e vai
    // até 23h continua na agenda enquanto está acontecendo. Sem hora de fim, a data de
    // início manda.
    listUpcomingEvents: (storeId, limit) => {
      const now = new Date();
      return db.product.findMany({
        where: {
          storeId,
          active: true,
          eventAt: { not: null },
          OR: [{ eventEndsAt: { gte: now } }, { eventEndsAt: null, eventAt: { gte: now } }],
        },
        orderBy: [{ eventAt: "asc" }, { id: "asc" }],
        take: limit,
        include: PRODUCT_INCLUDE,
      });
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
    category: product.category
      ? { id: product.category.id, slug: product.category.slug, name: product.category.name }
      : null,
    event: product.eventAt
      ? {
          at: product.eventAt.toISOString(),
          endsAt: product.eventEndsAt?.toISOString() ?? null,
          location: product.eventLocation,
        }
      : null,
    payout: agreement,
  };
}
