import type { StripeGateway } from "../../../../gateways/stripe/stripe.gateway.js";
import { ConflictError } from "../../../../shared/errors.js";
import type { DonationsRepository, DonationWithDetails } from "../donations.repository.js";

/**
 * Encerra a assinatura de uma doação mensal. Compartilhado entre quem doou e quem responde pela
 * loja: os dois caminhos precisam das mesmas garantias, e a única diferença é como a doação foi
 * encontrada.
 */
export async function cancelDonationSubscription(
  deps: { donations: DonationsRepository; stripe: StripeGateway },
  donation: DonationWithDetails,
): Promise<void> {
  if (donation.type !== "monthly" || !donation.subscriptionRef) {
    throw new ConflictError("not_a_subscription");
  }
  if (donation.subscriptionCancelledAt) {
    throw new ConflictError("subscription_already_cancelled");
  }
  // A assinatura vive na conta da plataforma (destination charge, ADR-025): cancelar não
  // depende de saber a conta conectada da loja.
  await deps.stripe.cancelSubscription(donation.subscriptionRef);
  // Marcado depois da confirmação do provedor: marcar antes deixaria a assinatura viva no
  // Stripe com a nossa linha dizendo que acabou (dinheiro saindo do doador sem doação
  // registrada). O webhook customer.subscription.deleted é a rede de segurança do caminho
  // inverso.
  await deps.donations.markSubscriptionCancelled(donation.subscriptionRef);
}
