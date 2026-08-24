import type { Prisma, PrismaClient } from "@prisma/client";
import { ConflictError } from "../../../shared/errors.js";
import {
  normalizePayoutFields,
  PAYOUT_ORDER_STATUSES,
  unitPayoutCents,
} from "../payouts/payouts.helpers.js";
import type { CreateEventBody, EventBatchInput, UpdateEventBody } from "./events.schema.js";

/**
 * Pedido que leva alguém à porta. `pending_payment` entra porque a pessoa reservou a vaga e
 * pode chegar com o Pix na mão — a lista de presença mostra isso marcado, não escondido.
 * Cancelado e expirado não levam ninguém; reembolsado desistiu.
 *
 * Exportado porque a lista de presença e o resultado do evento TÊM de usar a mesma régua:
 * duas contagens diferentes de "quantos garantiram vaga" na mesma tela é bug de confiança.
 */
export const EVENT_ATTENDING_STATUSES = [
  "pending_payment",
  "paid",
  "delivery_arranged",
  "delivered",
] as const;

// O nome de quem conduz vem junto porque a agenda da gestão mostra "quem recebe" ao lado do
// evento; a resposta pública descarta o bloco inteiro.
const EVENT_INCLUDE = {
  supplier: { select: { id: true, name: true } },
  // Os lotes vêm sempre: é deles que sai o preço e a vaga que valem agora, e uma consulta
  // a mais por tela de evento é mais barato que cada tela decidir sozinha qual preço mostrar.
  batches: { orderBy: { position: "asc" } },
} satisfies Prisma.EventInclude;

export type EventWithSupplier = Prisma.EventGetPayload<{ include: typeof EVENT_INCLUDE }>;
export type EventBatchRow = EventWithSupplier["batches"][number];

/** Preço e vaga que valem agora, com o lote de onde saem quando existe lote. */
export type ActiveOffer = {
  batch: EventBatchRow | null;
  priceCents: number;
  seats: number;
};

/**
 * O lote ativo é o primeiro, na ordem de venda, que ainda tem vaga E está dentro da janela.
 * Lote esgotado ou fora da janela é passado: o próximo assume sozinho, sem ninguém mexer.
 *
 * Sem lotes, o evento vende pelo próprio preço — é o caso simples e ele não paga por isso.
 */
export function activeOffer(event: EventWithSupplier, now = new Date()): ActiveOffer {
  if (event.batches.length === 0) {
    return { batch: null, priceCents: event.priceCents, seats: event.seats };
  }
  const open = event.batches.find(
    (batch) =>
      batch.seats > 0 &&
      (batch.opensAt === null || batch.opensAt.getTime() <= now.getTime()) &&
      (batch.closesAt === null || batch.closesAt.getTime() > now.getTime()),
  );
  // Nenhum lote aberto: o evento está lotado (ou entre janelas). O preço que aparece é o do
  // próximo que ainda pode abrir — "esgotado a R$ 30" com o R$ 40 na tela seria mentira ao
  // contrário, mas mostrar preço nenhum deixaria o card sem informação.
  if (!open) {
    const futuro = event.batches.find(
      (batch) =>
        batch.seats > 0 && batch.opensAt !== null && batch.opensAt.getTime() > now.getTime(),
    );
    const referencia = futuro ?? event.batches[event.batches.length - 1];
    return { batch: null, priceCents: referencia?.priceCents ?? event.priceCents, seats: 0 };
  }
  return { batch: open, priceCents: open.priceCents, seats: open.seats };
}

/**
 * Quanto vai custar depois que este lote acabar. É o que faz alguém comprar hoje em vez de
 * "semana que vem" — e só aparece quando o próximo é mais caro, porque anunciar um aumento
 * que não vem é o tipo de urgência falsa que queima a confiança da comunidade.
 */
export function nextBatchPrice(
  event: EventWithSupplier,
  current: EventBatchRow | null,
): number | null {
  if (!current) return null;
  const next = event.batches.find((batch) => batch.position > current.position && batch.seats > 0);
  return next && next.priceCents > current.priceCents ? next.priceCents : null;
}

/** Vagas ainda vendáveis no evento inteiro: soma dos lotes que ainda podem abrir. */
export function totalSeatsLeft(event: EventWithSupplier, now = new Date()): number {
  if (event.batches.length === 0) return event.seats;
  return event.batches
    .filter((batch) => batch.closesAt === null || batch.closesAt.getTime() > now.getTime())
    .reduce((sum, batch) => sum + batch.seats, 0);
}

/**
 * Quando o evento deixou de valer. O FIM manda quando existe: uma sessão que começou às 20h
 * e vai até 23h continua valendo enquanto está acontecendo. Sem hora de fim, o início manda.
 */
export function eventFinished(event: { at: Date; endsAt: Date | null }, now = new Date()): boolean {
  return (event.endsAt ?? event.at).getTime() < now.getTime();
}

export interface EventsRepository {
  findBySlug(storeId: string, slug: string): Promise<EventWithSupplier | null>;
  create(storeId: string, data: CreateEventBody): Promise<EventWithSupplier>;
  update(id: string, data: UpdateEventBody): Promise<EventWithSupplier>;
  archive(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  /**
   * Agenda pública: o que ainda vai acontecer, do mais próximo ao mais distante. Sem cursor
   * de propósito — agenda de núcleo tem dezenas de linhas, não milhares.
   */
  listUpcoming(storeId: string, limit: number): Promise<EventWithSupplier[]>;
  /**
   * Agenda da gestão. Do mais próximo para o mais distante, mas inclui o que já passou (é
   * onde fica a lista de presença de ontem) quando `includePast`.
   */
  listByStore(args: {
    storeId: string;
    limit: number;
    includePast: boolean;
  }): Promise<EventWithSupplier[]>;
  findActiveBySlugs(storeId: string, slugs: string[]): Promise<EventWithSupplier[]>;
  /**
   * Reescreve os lotes do evento. Lote que saiu do array é apagado; lote com vaga já vendida
   * é recusado, porque apagá-lo levaria embora de onde veio o ingresso de alguém.
   */
  replaceBatches(eventId: string, batches: EventBatchInput[]): Promise<void>;
  /** Quanto cada evento deu: vagas, presença e dinheiro. */
  listResults(args: {
    storeId: string;
    limit: number;
    includeUpcoming: boolean;
  }): Promise<EventResult[]>;
}

/**
 * Resultado de um evento. Duas réguas convivem aqui de propósito:
 *
 * - **vaga garantida** conta pedido pendente também (é quem aparece na porta);
 * - **dinheiro** conta só pedido pago, a mesma régua do repasse (`PAYOUT_ORDER_STATUSES`).
 *
 * Misturar as duas faria a tela prometer receita que ainda pode expirar.
 */
export type EventResult = {
  slug: string;
  name: string;
  at: Date;
  finished: boolean;
  /** Vagas que sobraram. Zero é lotado. */
  seatsLeft: number;
  soldQty: number;
  checkedInQty: number;
  paidQty: number;
  grossCents: number;
  payoutCents: number;
  feeCents: number;
  netCents: number;
};

export function createEventsRepository(db: PrismaClient): EventsRepository {
  return {
    findBySlug: (storeId, slug) =>
      db.event.findUnique({ where: { storeId_slug: { storeId, slug } }, include: EVENT_INCLUDE }),
    create: (storeId, data) =>
      db.event.create({
        data: {
          storeId,
          name: data.name,
          slug: data.slug,
          description: data.description ?? null,
          priceCents: data.priceCents,
          images: data.images ?? [],
          seats: data.seats,
          at: new Date(data.at),
          endsAt: data.endsAt ? new Date(data.endsAt) : null,
          location: data.location || null,
          ...normalizePayoutFields(data),
          ...(data.batches && data.batches.length > 0
            ? {
                batches: {
                  create: data.batches.map((batch, index) => ({
                    name: batch.name,
                    position: index,
                    priceCents: batch.priceCents,
                    seats: batch.seats,
                    opensAt: batch.opensAt ? new Date(batch.opensAt) : null,
                    closesAt: batch.closesAt ? new Date(batch.closesAt) : null,
                  })),
                },
              }
            : {}),
        },
        include: EVENT_INCLUDE,
      }),
    update: (id, data) =>
      db.event.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.priceCents !== undefined && { priceCents: data.priceCents }),
          ...(data.images !== undefined && { images: data.images }),
          ...(data.seats !== undefined && { seats: data.seats }),
          ...(data.at !== undefined && { at: new Date(data.at) }),
          ...(data.endsAt !== undefined && { endsAt: data.endsAt ? new Date(data.endsAt) : null }),
          ...(data.location !== undefined && { location: data.location || null }),
          // o acordo de repasse só é reescrito quando o formulário manda os três campos
          ...(data.supplierId !== undefined ||
          data.payoutKind !== undefined ||
          data.payoutValue !== undefined
            ? normalizePayoutFields(data)
            : {}),
        },
        include: EVENT_INCLUDE,
      }),
    // Arquivar não apaga: a lista de presença de um evento que já aconteceu é registro da
    // loja, e apagar o evento levaria embora o que aquele pedido comprou.
    archive: async (id) => {
      await db.event.update({ where: { id }, data: { active: false } });
    },
    restore: async (id) => {
      await db.event.update({ where: { id }, data: { active: true } });
    },
    listUpcoming: (storeId, limit) => {
      const now = new Date();
      return db.event.findMany({
        where: {
          storeId,
          active: true,
          OR: [{ endsAt: { gte: now } }, { endsAt: null, at: { gte: now } }],
        },
        orderBy: [{ at: "asc" }, { id: "asc" }],
        take: limit,
        include: EVENT_INCLUDE,
      });
    },
    listByStore: async ({ storeId, limit, includePast }) => {
      const now = new Date();
      const futuro: Prisma.EventWhereInput = {
        OR: [{ endsAt: { gte: now } }, { endsAt: null, at: { gte: now } }],
      };
      // O passado é escrito por extenso em vez de `NOT: futuro`: com `ends_at` nulo a
      // comparação `ends_at >= now` é NULL, e `NOT NULL` também é NULL — o evento de ontem
      // sem hora de fim ficava fora dos DOIS conjuntos e desaparecia da agenda.
      const passado: Prisma.EventWhereInput = {
        OR: [{ endsAt: { lt: now } }, { endsAt: null, at: { lt: now } }],
      };
      if (!includePast) {
        return db.event.findMany({
          where: { storeId, active: true, ...futuro },
          orderBy: [{ at: "asc" }, { id: "asc" }],
          take: limit,
          include: EVENT_INCLUDE,
        });
      }
      // Duas consultas em vez de um ORDER BY só porque a ordem que a pessoa espera não é
      // monotônica: o que vem primeiro é o próximo evento (crescente, o de hoje no topo) e
      // só depois o histórico (decrescente, o de ontem antes do de mês passado). Numa
      // ordenação única, o evento mais distante do futuro roubava o topo da tela que fica
      // aberta na porta.
      const [proximos, passados] = await Promise.all([
        db.event.findMany({
          where: { storeId, ...futuro },
          orderBy: [{ at: "asc" }, { id: "asc" }],
          take: limit,
          include: EVENT_INCLUDE,
        }),
        db.event.findMany({
          where: { storeId, ...passado },
          orderBy: [{ at: "desc" }, { id: "desc" }],
          take: limit,
          include: EVENT_INCLUDE,
        }),
      ]);
      return [...proximos, ...passados].slice(0, limit);
    },
    findActiveBySlugs: (storeId, slugs) =>
      db.event.findMany({
        where: { storeId, slug: { in: slugs }, active: true },
        include: EVENT_INCLUDE,
      }),

    replaceBatches: async (eventId, batches) => {
      await db.$transaction(async (tx) => {
        const atuais = await tx.eventBatch.findMany({
          where: { eventId },
          select: { id: true },
        });
        const mantidos = new Set(batches.flatMap((batch) => (batch.id ? [batch.id] : [])));
        const removidos = atuais.filter((batch) => !mantidos.has(batch.id)).map((b) => b.id);

        if (removidos.length > 0) {
          const vendidos = await tx.orderItem.findFirst({
            where: { eventBatchId: { in: removidos } },
            select: { eventBatchId: true },
          });
          if (vendidos) throw new ConflictError("event_batch_has_sales");
          await tx.eventBatch.deleteMany({ where: { id: { in: removidos } } });
        }

        // Posição vem do índice no array: a ordem que a loja arrastou na tela É a ordem de
        // venda. Reposicionar em duas passadas porque `(event_id, position)` é único e a
        // troca de duas linhas colidiria no meio do caminho.
        for (const [index, batch] of batches.entries()) {
          const data = {
            name: batch.name,
            priceCents: batch.priceCents,
            seats: batch.seats,
            opensAt: batch.opensAt ? new Date(batch.opensAt) : null,
            closesAt: batch.closesAt ? new Date(batch.closesAt) : null,
          };
          if (batch.id) {
            await tx.eventBatch.update({
              where: { id: batch.id },
              data: { ...data, position: -(index + 1) },
            });
          } else {
            await tx.eventBatch.create({
              data: { ...data, eventId, position: -(index + 1) },
            });
          }
        }
        const finais = await tx.eventBatch.findMany({
          where: { eventId },
          orderBy: { position: "desc" },
          select: { id: true },
        });
        for (const [index, batch] of finais.entries()) {
          await tx.eventBatch.update({ where: { id: batch.id }, data: { position: index } });
        }
      });
    },

    listResults: async ({ storeId, limit, includeUpcoming }) => {
      const now = new Date();
      // Do mais recente para trás: resultado se lê depois que o evento aconteceu.
      const events = await db.event.findMany({
        where: {
          storeId,
          ...(includeUpcoming
            ? {}
            : { OR: [{ endsAt: { lt: now } }, { endsAt: null, at: { lt: now } }] }),
        },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        take: limit,
        select: {
          id: true,
          slug: true,
          name: true,
          at: true,
          endsAt: true,
          seats: true,
          batches: { select: { seats: true, closesAt: true } },
        },
      });
      if (events.length === 0) return [];

      const items = await db.orderItem.findMany({
        where: {
          eventId: { in: events.map((event) => event.id) },
          order: { status: { in: [...EVENT_ATTENDING_STATUSES] } },
        },
        select: {
          eventId: true,
          qty: true,
          priceCents: true,
          payoutCents: true,
          checkedInAt: true,
          // a taxa fica no PAGAMENTO, não no pedido — é lá que ela foi congelada na venda
          order: {
            select: {
              status: true,
              totalCents: true,
              payment: { select: { applicationFeeCents: true } },
            },
          },
        },
      });

      const zero = () => ({
        soldQty: 0,
        checkedInQty: 0,
        paidQty: 0,
        grossCents: 0,
        payoutCents: 0,
        feeCents: 0,
      });
      const acc = new Map<string, ReturnType<typeof zero>>();
      for (const item of items) {
        if (!item.eventId) continue;
        const row = acc.get(item.eventId) ?? zero();
        row.soldQty += item.qty;
        if (item.checkedInAt) row.checkedInQty += item.qty;
        if ((PAYOUT_ORDER_STATUSES as string[]).includes(item.order.status)) {
          const bruto = item.priceCents * item.qty;
          row.paidQty += item.qty;
          row.grossCents += bruto;
          row.payoutCents += item.payoutCents;
          // A taxa foi congelada no PEDIDO, não no item: um pedido que levou vaga e mel
          // paga uma taxa só. Rateia pelo peso desta linha no pedido — usar a taxa atual da
          // loja reescreveria o passado toda vez que a comissão mudasse.
          const feeDoPedido = item.order.payment?.applicationFeeCents ?? 0;
          if (feeDoPedido > 0 && item.order.totalCents > 0) {
            row.feeCents += Math.round((bruto / item.order.totalCents) * feeDoPedido);
          }
        }
        acc.set(item.eventId, row);
      }

      return events.map((event) => {
        const counts = acc.get(event.id) ?? zero();
        return {
          slug: event.slug,
          name: event.name,
          at: event.at,
          finished: eventFinished(event, now),
          // com lotes, o que sobrou é a soma dos que ainda podem abrir
          seatsLeft:
            event.batches.length === 0
              ? event.seats
              : event.batches
                  .filter((batch) => batch.closesAt === null || batch.closesAt > now)
                  .reduce((sum, batch) => sum + batch.seats, 0),
          ...counts,
          netCents: counts.grossCents - counts.payoutCents - counts.feeCents,
        };
      });
    },
  };
}

export function toEventResponse(
  event: EventWithSupplier,
  publicUrl: (key: string) => string,
  options: { payout?: boolean } = {},
) {
  const agreement =
    options.payout && event.supplier && event.payoutKind && event.payoutValue !== null
      ? {
          supplierId: event.supplier.id,
          supplierName: event.supplier.name,
          kind: event.payoutKind,
          value: event.payoutValue,
          unitCents: unitPayoutCents(event),
        }
      : null;

  // O preço e a vaga da resposta são os que valem AGORA: com lotes vêm do lote ativo, sem
  // lotes vêm do próprio evento. Nenhuma tela precisa escolher entre dois números.
  const offer = activeOffer(event);
  const toBatch = (batch: EventBatchRow) => ({
    id: batch.id,
    name: batch.name,
    priceCents: batch.priceCents,
    seats: batch.seats,
    opensAt: batch.opensAt?.toISOString() ?? null,
    closesAt: batch.closesAt?.toISOString() ?? null,
    current: batch.id === offer.batch?.id,
  });

  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    description: event.description,
    priceCents: offer.priceCents,
    currency: event.currency,
    images: event.images,
    imageUrls: event.images.map(publicUrl),
    seats: offer.seats,
    seatsTotalLeft: totalSeatsLeft(event),
    batch: offer.batch ? toBatch(offer.batch) : null,
    nextPriceCents: nextBatchPrice(event, offer.batch),
    batches: event.batches.map(toBatch),
    at: event.at.toISOString(),
    endsAt: event.endsAt?.toISOString() ?? null,
    location: event.location,
    active: event.active,
    finished: eventFinished(event),
    createdAt: event.createdAt.toISOString(),
    payout: agreement,
  };
}
