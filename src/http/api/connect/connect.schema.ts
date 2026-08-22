import { z } from "zod";

/**
 * Nenhuma resposta desta slice devolve `stripeAccountId`, `wooviPixKey` inteira ou
 * `wooviSubaccountId`: são credenciais operacionais do núcleo (ver ADR-013). A exceção é
 * `pixKeyMasked` — sem ela a tela dizia "ligado" sem dizer ligado em qual chave, e a loja
 * não tinha como conferir se o dinheiro vai para a conta certa.
 */
export const ConnectStatusResponse = z.object({
  stripe: z.object({
    connected: z.boolean(),
    /** Capability `transfers`: é o que libera a loja a vender por destination charge. */
    transfersEnabled: z.boolean(),
    chargesEnabled: z.boolean(),
    payoutsEnabled: z.boolean(),
    detailsSubmitted: z.boolean(),
  }),
  woovi: z.object({
    connected: z.boolean(),
    /** Chave Pix parcial, só para reconhecimento: "ma***@gmail.com". */
    pixKeyMasked: z.string().nullable(),
  }),
  /** Taxa da plataforma em pontos-base (500 = 5%). A tela mostra o número de verdade
   *  em vez de uma promessa de "sem taxa" — transparência é parte da marca. */
  applicationFeeBps: z.number().int(),
  /**
   * Taxa de Woovi e Stripe por transação, em texto ("0,99%"). Quem paga é a plataforma:
   * o número está aqui para a loja saber que o custo existe, não para descontar da venda.
   * `null` quando a plataforma ainda não declarou o valor.
   */
  providerFees: z.object({
    pix: z.string().nullable(),
    card: z.string().nullable(),
  }),
});

export const OnboardingLinkResponse = z.object({ url: z.string() });

/** Login link do dashboard Express. Uso único e curta duração, como o de onboarding. */
export const DashboardLinkResponse = z.object({ url: z.string() });

/**
 * Client secret da Account Session. É credencial de curta duração de UM núcleo só: nunca
 * cacheada no front nem compartilhada entre lojas.
 */
export const AccountSessionResponse = z.object({ clientSecret: z.string() });

export const PutWooviConnectBody = z.object({
  pixKey: z.string().min(3).max(140),
});
export type PutWooviConnectBody = z.infer<typeof PutWooviConnectBody>;

/**
 * Saldo da subconta Woovi. É saldo VIRTUAL: fica reservado dentro da conta da
 * plataforma até o saque, e é isso que a tela precisa deixar claro para o núcleo.
 */
export const WooviBalanceResponse = z.object({
  /** `false` quando a loja ainda não configurou Pix ou a Woovi não conhece a chave. */
  available: z.boolean(),
  balanceCents: z.int().nonnegative(),
  withdrawBlocked: z.boolean(),
});

export const WooviWithdrawResponse = z.object({
  status: z.enum(["requested", "empty", "blocked"]),
  balanceCents: z.int().nonnegative(),
});
