import { z } from "zod";
import { GuestContact } from "../../../lib/guest-identity.js";

export const RESERVATION_TTL_MINUTES = 30;

export const CheckoutBody = z.object({
  storeSlug: z.string().min(1),
  provider: z.enum(["stripe", "woovi"]),
  items: z
    .array(z.object({ productSlug: z.string().min(1), qty: z.number().int().min(1).max(99) }))
    .min(1)
    .max(20),
  /** Opcional desde o fluxo sem conta: quem não está logado manda o telefone em `contact`. */
  contactPhone: z.string().min(8).max(20).optional(),
  note: z.string().max(500).optional(),
  /** Quem está comprando, quando não há sessão. Ignorado se houver Bearer token. */
  contact: GuestContact.optional(),
});
export type CheckoutBody = z.infer<typeof CheckoutBody>;

export const OrderItemResponse = z.object({
  productId: z.string(),
  name: z.string(),
  priceCents: z.number().int(),
  qty: z.number().int(),
});

export const OrderResponse = z.object({
  id: z.string(),
  store: z.object({ slug: z.string(), name: z.string() }),
  status: z.string(),
  totalCents: z.number().int(),
  currency: z.string(),
  contactPhone: z.string(),
  note: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
  items: z.array(OrderItemResponse),
  payment: z.object({ provider: z.string(), status: z.string() }).nullable(),
});

export const PaymentInstructions = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("stripe"), clientSecret: z.string() }),
  z.object({
    provider: z.literal("woovi"),
    brCode: z.string(),
    qrCodeImageUrl: z.string(),
    expiresAt: z.string(),
  }),
]);
export type PaymentInstructions = z.infer<typeof PaymentInstructions>;

export const CheckoutResponse = z.object({
  order: OrderResponse,
  payment: PaymentInstructions,
  /**
   * Chave do recibo público, só para pedido feito sem conta. É como a tela de confirmação
   * acompanha o Pix sem estar autenticada. Nulo para quem comprou logado.
   */
  receiptToken: z.string().nullable(),
});

/**
 * Cobrança Pix guardada, para a tela de pagamento renascer depois de um F5. Nula quando o
 * pagamento é no cartão — aí a tentativa morre com a aba, e é isso mesmo.
 */
export const PixCharge = z.object({
  brCode: z.string(),
  qrCodeImageUrl: z.string(),
  expiresAt: z.string(),
});

/** Recibo público: o que aconteceu com o pagamento, nada sobre quem pagou. */
export const OrderReceiptResponse = z.object({
  id: z.string(),
  status: z.string(),
  totalCents: z.number().int(),
  currency: z.string(),
  store: z.object({ slug: z.string(), name: z.string() }),
  items: z.array(
    z.object({ name: z.string(), qty: z.number().int(), priceCents: z.number().int() }),
  ),
  pix: PixCharge.nullable(),
  createdAt: z.string(),
});

export const OrdersPageResponse = z.object({
  items: z.array(OrderResponse),
  nextCursor: z.string().nullable(),
});

export const OrdersListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

export const StoreOrdersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
  status: z
    .enum(["pending_payment", "paid", "delivery_arranged", "delivered", "cancelled", "refunded"])
    .optional(),
});

export const UpdateOrderStatusBody = z.object({
  status: z.enum(["delivery_arranged", "delivered"]),
});

export const RefundAcceptedResponse = z.object({ status: z.literal("refund_requested") });
