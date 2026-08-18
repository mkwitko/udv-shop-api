import { z } from "zod";

/**
 * Nenhuma resposta desta slice devolve `stripeAccountId`, `wooviPixKey` ou
 * `wooviSubaccountId`: são credenciais operacionais do núcleo (ver ADR-013). O front
 * só precisa saber se está conectado e se já pode cobrar.
 */
export const ConnectStatusResponse = z.object({
  stripe: z.object({
    connected: z.boolean(),
    chargesEnabled: z.boolean(),
    payoutsEnabled: z.boolean(),
    detailsSubmitted: z.boolean(),
  }),
  woovi: z.object({ connected: z.boolean() }),
});

export const OnboardingLinkResponse = z.object({ url: z.string() });

export const PutWooviConnectBody = z.object({
  pixKey: z.string().min(3).max(140),
});
export type PutWooviConnectBody = z.infer<typeof PutWooviConnectBody>;
