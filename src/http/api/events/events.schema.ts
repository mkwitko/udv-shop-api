import { z } from "zod";
import { PayoutKindSchema } from "../payouts/payouts.schema.js";
import { SLUG_REGEX } from "../stores/stores.schema.js";

/**
 * Repasse a quem conduz o evento (facilitadora, oficineiro). Igual ao de produto: os três
 * campos andam juntos, e `null` nos três significa "a loja fica com tudo menos a taxa".
 */
const PayoutFields = {
  supplierId: z.string().uuid().nullable().optional(),
  payoutKind: PayoutKindSchema.nullable().optional(),
  payoutValue: z.number().int().min(0).nullable().optional(),
};

/**
 * Um lote no corpo do formulário. `id` vem preenchido quando é lote que já existe: é assim
 * que editar não recria a linha e não perde de vista as vagas já vendidas dela.
 */
export const EventBatchInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(80),
  priceCents: z.number().int().positive(),
  seats: z.number().int().min(0),
  opensAt: z.string().datetime().nullable().optional(),
  closesAt: z.string().datetime().nullable().optional(),
});
export type EventBatchInput = z.infer<typeof EventBatchInput>;

/** Lote como a tela vê. A ordem do array É a ordem de venda. */
export const EventBatchResponse = z.object({
  id: z.string(),
  name: z.string(),
  priceCents: z.int(),
  /** Vagas restantes NESTE lote. Zero é lote esgotado. */
  seats: z.int().nonnegative(),
  opensAt: z.string().nullable(),
  closesAt: z.string().nullable(),
  /** `true` no lote que está vendendo agora. No máximo um. */
  current: z.boolean(),
});

export const CreateEventBody = z.object({
  name: z.string().min(2).max(160),
  slug: z.string().min(3).max(80).regex(SLUG_REGEX),
  description: z.string().max(5000).optional(),
  priceCents: z.number().int().positive(),
  images: z.array(z.string().startsWith("stores/")).max(10).optional(),
  /** Vagas. Zero é evento lotado, não evento inválido — a fila de espera vive disso. */
  seats: z.number().int().min(0).default(0),
  at: z.string().datetime(),
  endsAt: z.string().datetime().nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  /**
   * Lotes, na ordem de venda. Lista vazia (ou ausente) é evento de preço único, que vende
   * por `priceCents`/`seats` — o caso simples não paga o custo de cadastrar lote.
   */
  batches: z.array(EventBatchInput).max(10).optional(),
  ...PayoutFields,
});
export type CreateEventBody = z.infer<typeof CreateEventBody>;

export const UpdateEventBody = z.object({
  name: z.string().min(2).max(160).optional(),
  description: z.string().max(5000).nullable().optional(),
  priceCents: z.number().int().positive().optional(),
  images: z.array(z.string().startsWith("stores/")).max(10).optional(),
  seats: z.number().int().min(0).optional(),
  at: z.string().datetime().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  /**
   * Substitui a lista inteira quando enviada: lote que sai do array é apagado, e lote com
   * vaga já vendida é recusado em vez de apagado — apagar levaria embora de onde veio o
   * ingresso de alguém. Ausente não mexe em lote nenhum.
   */
  batches: z.array(EventBatchInput).max(10).optional(),
  ...PayoutFields,
});
export type UpdateEventBody = z.infer<typeof UpdateEventBody>;

export const EventResponse = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  priceCents: z.number().int(),
  currency: z.string(),
  images: z.array(z.string()),
  imageUrls: z.array(z.string()),
  /**
   * Vagas que dá para comprar agora. Com lotes, é o que resta no lote ativo — não a soma de
   * todos: prometer 80 vagas quando só 20 estão à venda é vender o que não existe ainda.
   */
  seats: z.number().int(),
  /** Vagas ainda vendáveis no evento inteiro, somando os lotes que podem abrir. */
  seatsTotalLeft: z.int().nonnegative(),
  /** Lote que está vendendo agora. `null` em evento de preço único ou já lotado. */
  batch: EventBatchResponse.nullable(),
  /** Preço do próximo lote, quando ele é mais caro. É o que faz comprar hoje. */
  nextPriceCents: z.int().nullable(),
  batches: z.array(EventBatchResponse),
  at: z.string(),
  endsAt: z.string().nullable(),
  location: z.string().nullable(),
  active: z.boolean(),
  /** `true` quando a data (ou o fim, se houver) já passou. Quem passou não vende vaga. */
  finished: z.boolean(),
  createdAt: z.string(),
  /** Só para quem cuida da loja: acordo de repasse é conversa interna, não vitrine. */
  payout: z
    .object({
      supplierId: z.string(),
      supplierName: z.string(),
      kind: PayoutKindSchema,
      value: z.number().int(),
      unitCents: z.number().int(),
    })
    .nullable(),
});

export const EventsListResponse = z.object({ items: z.array(EventResponse) });

export const ListEventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListEventsQuery = z.infer<typeof ListEventsQuery>;

export const ListStoreEventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /**
   * A agenda da gestão mostra o que já passou (é onde fica a lista de presença de ontem) e
   * o que foi arquivado; a pública, não. Daí o filtro existir só aqui.
   */
  all: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default(false),
});
export type ListStoreEventsQuery = z.infer<typeof ListStoreEventsQuery>;

/**
 * Uma linha por ingresso vendido. `qty` importa: uma pessoa compra três vagas e leva três
 * pessoas — a presença é marcada na linha, não por cabeça, porque quem confere na porta
 * confere quem comprou.
 */
export const AttendeeResponse = z.object({
  orderItemId: z.string(),
  orderId: z.string(),
  name: z.string(),
  /** Telefone completo: quem confere na porta precisa ligar para quem não chegou. */
  phone: z.string(),
  qty: z.number().int(),
  paidCents: z.number().int(),
  orderStatus: z.string(),
  checkedInAt: z.string().nullable(),
});

export const AttendeesResponse = z.object({
  event: z.object({
    slug: z.string(),
    name: z.string(),
    at: z.string(),
    location: z.string().nullable(),
  }),
  /** Vagas vendidas e ainda livres, para a loja saber se pode aceitar mais gente. */
  soldQty: z.number().int(),
  checkedInQty: z.number().int(),
  remaining: z.number().int(),
  items: z.array(AttendeeResponse),
});

export const CheckInBody = z.object({ present: z.boolean() });
export type CheckInBody = z.infer<typeof CheckInBody>;

/**
 * Quanto cada evento deu. Duas réguas convivem de propósito: vaga garantida conta pedido
 * pendente (é quem aparece na porta), dinheiro conta só pedido pago (o pendente ainda pode
 * expirar). A tela diz qual é qual — misturar prometeria receita que não existe.
 */
export const EventResultResponse = z.object({
  slug: z.string(),
  name: z.string(),
  at: z.string(),
  finished: z.boolean(),
  /** Vagas que sobraram. Zero é lotado. */
  seatsLeft: z.int().nonnegative(),
  /** Vagas garantidas, incluindo quem ainda não pagou. */
  soldQty: z.int().nonnegative(),
  checkedInQty: z.int().nonnegative(),
  /** Vagas de pedido pago: é a base do dinheiro abaixo. */
  paidQty: z.int().nonnegative(),
  grossCents: z.int().nonnegative(),
  /** Combinado com quem conduz o evento, congelado na venda. */
  payoutCents: z.int().nonnegative(),
  /**
   * O que ficou retido no pagamento, rateado pelo peso do evento no pedido. A comissão é
   * zero desde o ADR-027, mas no Pix isto vem 1 centavo: a Woovi recusa split de 100%, e
   * esse centavo não chega na conta da loja. O líquido precisa contar essa verdade.
   */
  feeCents: z.int().nonnegative(),
  netCents: z.int(),
});

export const EventResultsResponse = z.object({ items: z.array(EventResultResponse) });

export const ListEventResultsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** Por padrão só o que já aconteceu: resultado de evento que nem começou é zero. */
  upcoming: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default(false),
});
export type ListEventResultsQuery = z.infer<typeof ListEventResultsQuery>;
