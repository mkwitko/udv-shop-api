import { z } from "zod";
import { ProductResponse } from "../products/products.schema.js";

/**
 * Agenda pública da loja. Devolve o mesmo objeto de produto (evento É produto com data),
 * então a vitrine renderiza card de evento e card de produto com o mesmo tipo.
 */
export const EventsListResponse = z.object({
  items: z.array(ProductResponse),
});

export const EventsListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type EventsListQuery = z.infer<typeof EventsListQuery>;

/**
 * Uma linha por ingresso vendido. `qty` importa: uma pessoa compra três ingressos e leva
 * três pessoas — a presença é marcada na linha, não por cabeça, porque quem confere na
 * porta confere quem comprou.
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
  /** Vagas vendidas e ainda disponíveis, para a loja saber se pode aceitar mais gente. */
  soldQty: z.number().int(),
  checkedInQty: z.number().int(),
  remaining: z.number().int(),
  items: z.array(AttendeeResponse),
});

export const CheckInBody = z.object({ present: z.boolean() });
export type CheckInBody = z.infer<typeof CheckInBody>;
