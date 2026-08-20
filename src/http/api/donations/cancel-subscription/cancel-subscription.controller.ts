import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ConflictError, NotFoundError } from "../../../../shared/errors.js";
import { requireUser } from "../../../hooks/auth.js";
import { createDonationsRepository } from "../donations.repository.js";
import { CancelSubscriptionResponse } from "../donations.schema.js";

export const cancelSubscriptionRoute: FastifyPluginAsync = async (app) => {
  const repo = createDonationsRepository(db);
  app.delete(
    "/donations/:id/subscription",
    {
      config: { permissions: { any: ["customer"] } },
      schema: {
        operationId: "cancelDonationSubscription",
        tags: ["donations"],
        params: z.object({ id: z.string().uuid() }),
        response: { 202: CancelSubscriptionResponse },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const { id } = req.params as { id: string };
      const donation = await repo.findByIdForUser(id, user.sub);
      if (!donation) throw new NotFoundError("donation_not_found");
      if (donation.type !== "monthly" || !donation.subscriptionRef) {
        throw new ConflictError("not_a_subscription");
      }
      if (donation.subscriptionCancelledAt) {
        throw new ConflictError("subscription_already_cancelled");
      }
      // A assinatura vive na conta da plataforma (destination charge, ADR-025): cancelar
      // não depende mais de saber a conta conectada da loja.
      await app.gateways.stripe.cancelSubscription(donation.subscriptionRef);
      // Marcado depois da confirmação do provedor: marcar antes deixaria a assinatura
      // viva no Stripe com a nossa linha dizendo que acabou (dinheiro saindo do doador
      // sem doação registrada). O webhook customer.subscription.deleted é a rede de
      // segurança para o caminho inverso.
      await repo.markSubscriptionCancelled(donation.subscriptionRef);
      void reply.code(202).send({ status: "subscription_cancelled" });
    },
  );
};
