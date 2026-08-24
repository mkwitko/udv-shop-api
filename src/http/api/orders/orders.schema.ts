import { z } from "zod";
import { GuestContact } from "../../../lib/guest-identity.js";

export const RESERVATION_TTL_MINUTES = 30;

export const CheckoutBody = z.object({
  storeSlug: z.string().min(1),
  provider: z.enum(["stripe", "woovi"]),
  /** Cada linha é um produto OU uma vaga de evento — nunca os dois. */
  items: z
    .array(
      z
        .object({
          productSlug: z.string().min(1).optional(),
          eventSlug: z.string().min(1).optional(),
          qty: z.number().int().min(1).max(99),
        })
        .refine((item) => Boolean(item.productSlug) !== Boolean(item.eventSlug), {
          message: "informe productSlug ou eventSlug",
          path: ["productSlug"],
        }),
    )
    .min(1)
    .max(20),
  /** Opcional desde o fluxo sem conta: quem não está logado manda o telefone em `contact`. */
  contactPhone: z.string().min(8).max(20).optional(),
  note: z.string().max(500).optional(),
  /** Quem está comprando, quando não há sessão. Ignorado se houver Bearer token. */
  contact: GuestContact.optional(),
  /**
   * Desafio anti-abuso, exigido de quem não tem sessão quando a plataforma tem Turnstile
   * configurado. Ignorado quando o desafio está desligado.
   */
  captchaToken: z.string().max(4096).optional(),
});
export type CheckoutBody = z.infer<typeof CheckoutBody>;

export const OrderItemResponse = z.object({
  /** `produto` ou `evento`: decide para onde o recibo linka de volta. */
  kind: z.enum(["produto", "evento"]),
  /** Endereço do que foi comprado, para o link de volta. */
  slug: z.string(),
  name: z.string(),
  priceCents: z.number().int(),
  qty: z.number().int(),
  /** Preenchido quando o item é vaga de evento: é o que faz "meus ingressos" existir. */
  event: z.object({ at: z.string(), location: z.string().nullable() }).nullable(),
  /** Presença conferida na porta. */
  checkedInAt: z.string().nullable(),
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
  /**
   * Telefone parcial de contato do pedido — "(48) ****-5678". A tela de confirmação
   * devolve para a pessoa o número que a loja vai chamar: dígito errado aqui é pedido
   * pago e entrega que nunca acontece. Parcial porque o link do recibo circula em grupo.
   */
  contactPhoneMasked: z.string().nullable(),
  /** Como a loja combina entrega/retirada, nas palavras dela. */
  deliveryNote: z.string().nullable(),
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
