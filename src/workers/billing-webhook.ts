import type { PrismaClient, StoreSubscriptionStatus } from "@prisma/client";
import { createBillingRepository } from "../http/api/billing/billing.repository.js";
import { createStoresRepository } from "../http/api/stores/stores.repository.js";

type StripeRef = string | { id?: string } | null | undefined;

type CheckoutSessionObject = {
  mode?: string;
  customer?: StripeRef;
  client_reference_id?: string | null;
  metadata?: Record<string, string>;
};

type SubscriptionObject = {
  id?: string;
  customer?: StripeRef;
  status?: string;
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  metadata?: Record<string, string>;
  items?: { data?: Array<{ current_period_end?: number; price?: { id?: string } }> };
};

type AccountObject = {
  id?: string;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
};

/** Campos de referência do Stripe chegam como id ou como objeto expandido. */
function idOf(ref: StripeRef): string | null {
  if (typeof ref === "string") return ref;
  if (ref && typeof ref === "object" && typeof ref.id === "string") return ref.id;
  return null;
}

/**
 * Status do Stripe → nosso enum. `unpaid` e `incomplete_expired` são tratados como
 * `canceled`: em ambos o Stripe desistiu de cobrar, e para a plataforma isso é a mesma
 * decisão (tirar a loja do ar). `paused` cai em `past_due`, que é carência.
 */
const STATUS_MAP: Record<string, StoreSubscriptionStatus> = {
  incomplete: "incomplete",
  incomplete_expired: "canceled",
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  paused: "past_due",
  unpaid: "canceled",
  canceled: "canceled",
};

/**
 * Guarda o customer da assinatura SaaS assim que o checkout fecha. A Subscription em si
 * chega pelos eventos `customer.subscription.*` — desde Basil o Checkout só a cria depois
 * do pagamento confirmado, então a sessão pode fechar sem id de assinatura nenhum.
 */
export async function applyCheckoutCompleted(
  db: PrismaClient,
  object: CheckoutSessionObject,
): Promise<void> {
  if (object.mode !== "subscription") return;
  const storeId = object.metadata?.storeId ?? object.client_reference_id ?? null;
  const customerId = idOf(object.customer);
  if (!storeId || !customerId) return;
  await createBillingRepository(db).attachCustomer(storeId, customerId);
}

export async function applySubscriptionEvent(
  db: PrismaClient,
  object: SubscriptionObject,
  eventType: string,
): Promise<void> {
  const subscriptionId = object.id;
  const customerId = idOf(object.customer);
  if (!subscriptionId || !customerId) return;

  const repo = createBillingRepository(db);
  // A metadata viaja na subscription desde o checkout; o lookup pelo id é a rede para
  // assinatura criada ou migrada fora do nosso fluxo.
  const storeId =
    object.metadata?.storeId ?? (await repo.findStoreIdBySubscriptionId(subscriptionId));
  if (!storeId) return;

  // `deleted` chega com o status que a assinatura tinha ao morrer, não com "canceled".
  const rawStatus = eventType === "customer.subscription.deleted" ? "canceled" : object.status;
  const status = STATUS_MAP[rawStatus ?? ""] ?? "incomplete";

  const item = object.items?.data?.[0];
  // Em Basil+ o período vive no item da assinatura; o campo no topo só existe em versões
  // anteriores e fica como fallback.
  const periodEnd = item?.current_period_end ?? object.current_period_end ?? null;

  await repo.applySubscriptionState({
    storeId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    status,
    priceId: item?.price?.id ?? null,
    currentPeriodEnd: periodEnd === null ? null : new Date(periodEnd * 1000),
    cancelAtPeriodEnd: object.cancel_at_period_end === true,
  });
}

/**
 * `account.updated` é o único jeito de saber que o núcleo terminou o onboarding: o
 * Account Link volta o usuário para o front sem nenhuma garantia de que o Stripe já
 * habilitou a conta.
 */
export async function applyAccountUpdated(
  db: PrismaClient,
  object: AccountObject,
): Promise<number> {
  if (!object.id) return 0;
  return createStoresRepository(db).setStripeCapabilities(object.id, {
    chargesEnabled: object.charges_enabled === true,
    payoutsEnabled: object.payouts_enabled === true,
    detailsSubmitted: object.details_submitted === true,
  });
}
