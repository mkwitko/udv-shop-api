import { z } from "zod";
import { GuestContact } from "../../../lib/guest-identity.js";

export const DONATION_MIN_CENTS = 500;
export const DONATION_MAX_CENTS = 5_000_000;
export const DONATION_TTL_MINUTES = 30;

export const CreateDonationBody = z.object({
  storeSlug: z.string().min(1),
  campaignSlug: z.string().min(1).optional(),
  provider: z.enum(["stripe", "woovi"]),
  type: z.enum(["one_time", "monthly"]).default("one_time"),
  amountCents: z.number().int().min(DONATION_MIN_CENTS).max(DONATION_MAX_CENTS),
  anonymous: z.boolean().default(false),
  message: z.string().max(500).optional(),
  /**
   * Quem está doando, quando não há sessão. Ignorado se houver Bearer token, e recusado para
   * `monthly` — assinatura precisa de conta, é lá que se cancela.
   */
  contact: GuestContact.optional(),
});
export type CreateDonationBody = z.infer<typeof CreateDonationBody>;

export const DonationResponse = z.object({
  id: z.string(),
  store: z.object({ slug: z.string(), name: z.string() }),
  campaign: z.object({ slug: z.string(), title: z.string() }).nullable(),
  type: z.enum(["one_time", "monthly"]),
  amountCents: z.number().int(),
  currency: z.string(),
  status: z.string(),
  anonymous: z.boolean(),
  message: z.string().nullable(),
  subscriptionActive: z.boolean(),
  raffleNumbers: z.array(z.number().int()),
  createdAt: z.string(),
});

// Variante própria do slice (não reusa a de orders): a mensal devolve o id da
// assinatura junto do client secret, e a única segue idêntica ao checkout de pedido.
export const DonationPaymentInstructions = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("stripe"), clientSecret: z.string() }),
  z.object({
    provider: z.literal("stripe_subscription"),
    clientSecret: z.string(),
    subscriptionId: z.string(),
  }),
  z.object({
    provider: z.literal("woovi"),
    brCode: z.string(),
    qrCodeImageUrl: z.string(),
    expiresAt: z.string(),
  }),
]);
export type DonationPaymentInstructions = z.infer<typeof DonationPaymentInstructions>;

export const CreateDonationResponse = z.object({
  donation: DonationResponse,
  payment: DonationPaymentInstructions,
  /**
   * Chave do recibo público, só para doação feita sem conta. É como a tela de confirmação
   * acompanha o Pix e mostra os números da sorte sem estar autenticada.
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

/** Recibo público da doação: status, valor e números da sorte. Nada sobre quem doou. */
export const DonationReceiptResponse = z.object({
  id: z.string(),
  status: z.string(),
  type: z.enum(["one_time", "monthly"]),
  amountCents: z.number().int(),
  currency: z.string(),
  store: z.object({ slug: z.string(), name: z.string() }),
  campaign: z.object({ slug: z.string(), title: z.string() }).nullable(),
  raffleNumbers: z.array(z.number().int()),
  pix: PixCharge.nullable(),
  createdAt: z.string(),
});

export const DonationsPageResponse = z.object({
  items: z.array(DonationResponse),
  nextCursor: z.string().nullable(),
});

export const DonationsListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
  status: z.enum(["pending_payment", "paid", "failed", "cancelled", "refunded"]).optional(),
});

export const StoreDonationsQuery = DonationsListQuery.extend({
  campaignSlug: z.string().min(1).optional(),
});

// Doador visto pela gestão da loja: nome e email completos (é quem agradece e
// emite recibo). Nunca sai em rota pública — ver D11.
export const StoreDonationResponse = DonationResponse.extend({
  donor: z.object({
    name: z.string(),
    /** Nulável: quem doa sem conta pode ter deixado só telefone. */
    email: z.string().nullable(),
    phone: z.string().nullable(),
  }),
});

export const StoreDonationsPageResponse = z.object({
  items: z.array(StoreDonationResponse),
  nextCursor: z.string().nullable(),
});

export const CancelSubscriptionResponse = z.object({ status: z.literal("subscription_cancelled") });
