import type { Store } from "@prisma/client";
import { env } from "../../../config/env.js";
import { maskPixKey } from "../../../lib/mask.js";

/**
 * URLs de volta do onboarding hospedado, sempre no domínio do front. Aponta para
 * Recebimento porque é lá que o estado da conta aparece — mandar para uma rota que
 * não existe deixava a pessoa num 404 justamente ao voltar do banco.
 */
export function connectUrls(slug: string) {
  const base = `${env.WEB_ORIGIN}/gestao/${slug}/recebimento`;
  return { refreshUrl: `${base}?connect=refresh`, returnUrl: `${base}?connect=ok` };
}

export function toConnectStatusResponse(store: Store) {
  return {
    stripe: {
      connected: store.stripeAccountId !== null,
      transfersEnabled: store.stripeTransfersEnabled,
      chargesEnabled: store.stripeChargesEnabled,
      payoutsEnabled: store.stripePayoutsEnabled,
      detailsSubmitted: store.stripeDetailsSubmitted,
    },
    woovi: { connected: store.wooviPixKey !== null, pixKeyMasked: maskPixKey(store.wooviPixKey) },
    applicationFeeBps: store.applicationFeeBps,
  };
}
