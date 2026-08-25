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
        const atual = await tx.storeSubscription.findUnique({ where: { storeId: state.storeId } });
        // A loja guarda UMA assinatura, mas o Stripe pode ter mais de uma com o mesmo
        // `metadata.storeId` (tentativa duplicada quando o webhook estava fora do ar).
        // Sem separar por id, cancelar a duplicada suspendia a loja que estava em dia.
        if (
          atual?.stripeSubscriptionId &&
          atual.stripeSubscriptionId !== state.stripeSubscriptionId
        ) {
          const novaVigente = state.status === "active" || state.status === "trialing";
          // Duplicada morrendo não mexe em nada: quem manda é a assinatura registrada.
          if (!novaVigente) return;
          const atualVigente = atual.status === "active" || atual.status === "trialing";
          // Entre duas vigentes, a de ciclo mais longe é a mais recente — assinatura velha
          // não pode roubar o registro da que a loja acabou de contratar.
          const maisRecente =
            (state.currentPeriodEnd?.getTime() ?? 0) > (atual.currentPeriodEnd?.getTime() ?? 0);
          if (atualVigente && !maisRecente) return;
        }

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

        // Assinatura em dia libera a loja sozinha: nunca houve aprovação manual no caminho
        // felizid. Ela sai de `pending` (primeira assinatura) e volta de `suspended` quando
        // foi a própria cobrança que a derrubou. Suspensão por decisão da plataforma
        // (moderação, ADR-006) não é desfeita por pagamento — quem reativa é o
        // platform_admin. Já o cancelamento tira do ar quem estava no ar.
        if (state.status === "active" || state.status === "trialing") {
          await tx.store.updateMany({
            where: {
              id: state.storeId,
              OR: [{ status: "pending" }, { status: "suspended", suspensionReason: "billing" }],
            },
            data: { status: "active", suspensionReason: null },
          });
          return;
        }
        if (state.status === "canceled") {
          await tx.store.updateMany({
            where: { id: state.storeId, status: "active" },
            data: { status: "suspended", suspensionReason: "billing" },
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
