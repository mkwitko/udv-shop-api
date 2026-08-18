import { z } from "zod";

export const BILLING_STATUSES = [
  "none",
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "canceled",
] as const;

/**
 * Nunca devolve `stripeCustomerId`/`stripeSubscriptionId`: são referências do provedor,
 * inúteis para o front e sensíveis no log de quem espelhar a resposta.
 */
export const BillingStatusResponse = z.object({
  status: z.enum(BILLING_STATUSES),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
});

export const BillingLinkResponse = z.object({ url: z.string() });
