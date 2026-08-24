import type { Store } from "@prisma/client";
import { ValidationError } from "../shared/errors.js";

/**
 * A chave Pix da loja pode receber?
 *
 * `pending` é chave declarada e não provada — e é exatamente a chave de terceiro usada como
 * fantoche que a prova de posse existe para barrar: as vendas cairiam na conta de um
 * inocente, com a trilha do golpe apontando para ele. `legacy` é a chave que já estava
 * gravada quando a verificação passou a existir: recebe, porque tirar do ar quem já vendia
 * seria pior que o risco, e a gestão pede a prova.
 */
export function wooviCanReceive(store: Store): boolean {
  if (!store.wooviPixKey) return false;
  return store.wooviPixKeyStatus === "verified" || store.wooviPixKeyStatus === "legacy";
}

/**
 * Barra antes de criar pedido ou doação. Ter conta conectada não é o mesmo que poder
 * receber: no Stripe, até a capability `transfers` ficar ativa o repasse é recusado e o
 * dinheiro fica preso na plataforma; no Pix, chave sem posse provada não recebe. Nos dois
 * casos, deixar passar aqui produz venda cujo dinheiro não chega em quem vendeu.
 */
export function assertProviderConfigured(store: Store, provider: "stripe" | "woovi"): void {
  const configured =
    provider === "stripe"
      ? store.stripeAccountId && store.stripeTransfersEnabled
      : wooviCanReceive(store);
  if (!configured) throw new ValidationError("payments_not_configured");
}
