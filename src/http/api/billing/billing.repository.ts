import type { PrismaClient, StoreSubscription, StoreSubscriptionStatus } from "@prisma/client";

export type SubscriptionState = {
  storeId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  status: StoreSubscriptionStatus;
  priceId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
};

export interface BillingRepository {
  findByStoreId(storeId: string): Promise<StoreSubscription | null>;
  findStoreIdBySubscriptionId(stripeSubscriptionId: string): Promise<string | null>;
  attachCustomer(storeId: string, stripeCustomerId: string): Promise<StoreSubscription>;
  applySubscriptionState(state: SubscriptionState): Promise<void>;
}

export function createBillingRepository(db: PrismaClient): BillingRepository {
  return {
    findByStoreId: (storeId) => db.storeSubscription.findUnique({ where: { storeId } }),

    findStoreIdBySubscriptionId: async (stripeSubscriptionId) => {
      const row = await db.storeSubscription.findUnique({
        where: { stripeSubscriptionId },
        select: { storeId: true },
      });
      return row?.storeId ?? null;
    },

    attachCustomer: (storeId, stripeCustomerId) =>
      db.storeSubscription.upsert({
        where: { storeId },
        create: { storeId, stripeCustomerId },
        update: { stripeCustomerId },
      }),

    applySubscriptionState: async (state) => {
      await db.$transaction(async (tx) => {
        await tx.storeSubscription.upsert({
          where: { storeId: state.storeId },
          create: {
            storeId: state.storeId,
            stripeCustomerId: state.stripeCustomerId,
            stripeSubscriptionId: state.stripeSubscriptionId,
            status: state.status,
            priceId: state.priceId,
            currentPeriodEnd: state.currentPeriodEnd,
            cancelAtPeriodEnd: state.cancelAtPeriodEnd,
          },
          update: {
            stripeCustomerId: state.stripeCustomerId,
            stripeSubscriptionId: state.stripeSubscriptionId,
            status: state.status,
            priceId: state.priceId,
            currentPeriodEnd: state.currentPeriodEnd,
            cancelAtPeriodEnd: state.cancelAtPeriodEnd,
          },
        });

        // Ativação só sai de `pending`: uma loja `suspended` foi suspensa por decisão da
        // plataforma (moderação, ADR-006), e assinatura em dia não desfaz isso — quem
        // reativa é o platform_admin. Já o cancelamento tira do ar quem estava no ar.
        if (state.status === "active" || state.status === "trialing") {
          await tx.store.updateMany({
            where: { id: state.storeId, status: "pending" },
            data: { status: "active" },
          });
          return;
        }
        if (state.status === "canceled") {
          await tx.store.updateMany({
            where: { id: state.storeId, status: "active" },
            data: { status: "suspended" },
          });
        }
        // `past_due` é carência: a loja segue no ar até o Stripe desistir e mandar
        // `canceled`.
      });
    },
  };
}

export function toBillingStatusResponse(subscription: StoreSubscription | null) {
  if (!subscription) {
    return { status: "none" as const, currentPeriodEnd: null, cancelAtPeriodEnd: false };
  }
  return {
    status: subscription.status,
    currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
  };
}
