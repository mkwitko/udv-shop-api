import { z } from "zod";

export const RESERVATION_TTL_MINUTES = 30;

export const CheckoutBody = z.object({
  storeSlug: z.string().min(1),
  provider: z.enum(["stripe", "woovi"]),
  items: z
    .array(z.object({ productSlug: z.string().min(1), qty: z.number().int().min(1).max(99) }))
    .min(1)
    .max(20),
  contactPhone: z.string().min(8).max(20),
  note: z.string().max(500).optional(),
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
});

export const OrdersPageResponse = z.object({
  items: z.array(OrderResponse),
  nextCursor: z.string().nullable(),
});

export const OrdersListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});
