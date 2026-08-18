import { z } from "zod";

export const PayoutKindSchema = z.enum(["fixed_cents", "percent_bps"]);

export const SupplierResponse = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  pixKey: z.string().nullable(),
  note: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.string(),
});

export const SuppliersPageResponse = z.object({
  items: z.array(SupplierResponse),
  nextCursor: z.string().nullable(),
});

export const ListSuppliersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
  all: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default(false),
});
export type ListSuppliersQuery = z.infer<typeof ListSuppliersQuery>;

export const CreateSupplierBody = z.object({
  name: z.string().min(2).max(120),
  phone: z.string().max(32).optional(),
  pixKey: z.string().max(140).optional(),
  note: z.string().max(500).optional(),
});
export type CreateSupplierBody = z.infer<typeof CreateSupplierBody>;

export const UpdateSupplierBody = z.object({
  name: z.string().min(2).max(120).optional(),
  phone: z.string().max(32).nullable().optional(),
  pixKey: z.string().max(140).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  active: z.boolean().optional(),
});
export type UpdateSupplierBody = z.infer<typeof UpdateSupplierBody>;

const Money = z.object({
  earnedCents: z.number().int(),
  settledCents: z.number().int(),
  balanceCents: z.number().int(),
});

export const PayoutBalanceResponse = Money.extend({ supplier: SupplierResponse });

export const PayoutsResponse = z.object({
  items: z.array(PayoutBalanceResponse),
  totals: Money,
});

export const PayoutDetailResponse = Money.extend({
  supplier: SupplierResponse,
  sales: z.array(
    z.object({
      orderId: z.string(),
      productName: z.string(),
      qty: z.number().int(),
      payoutCents: z.number().int(),
      soldAt: z.string(),
      orderStatus: z.string(),
    }),
  ),
  settlements: z.array(
    z.object({
      id: z.string(),
      amountCents: z.number().int(),
      note: z.string().nullable(),
      paidAt: z.string(),
      byName: z.string().nullable(),
    }),
  ),
});

export const CreateSettlementBody = z.object({
  amountCents: z.number().int().positive(),
  note: z.string().max(500).optional(),
  /** Quando o dinheiro saiu de fato — a loja pode registrar um Pix de ontem. */
  paidAt: z.string().datetime().optional(),
});
export type CreateSettlementBody = z.infer<typeof CreateSettlementBody>;

export const SettlementResponse = z.object({
  id: z.string(),
  supplierId: z.string(),
  amountCents: z.number().int(),
  note: z.string().nullable(),
  paidAt: z.string(),
  balanceCents: z.number().int(),
});
