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
  /** Taxa da plataforma em pontos-base (500 = 5%). A tela mostra o número de verdade
   *  em vez de uma promessa de "sem taxa" — transparência é parte da marca. */
  applicationFeeBps: z.number().int(),
});

export const OnboardingLinkResponse = z.object({ url: z.string() });

export const PutWooviConnectBody = z.object({
  pixKey: z.string().min(3).max(140),
});
export type PutWooviConnectBody = z.infer<typeof PutWooviConnectBody>;
