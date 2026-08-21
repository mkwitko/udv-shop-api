import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { cancelDonationSubscription } from "../cancel-subscription/cancel-subscription.service.js";
import { createDonationsRepository } from "../donations.repository.js";
import { CancelSubscriptionResponse } from "../donations.schema.js";
import { resolveStoreForRole } from "../manage.helpers.js";

export const cancelStoreSubscriptionRoute: FastifyPluginAsync = async (app) => {
  const repo = createDonationsRepository(db);
  app.delete(
    "/stores/:slug/donations/:id/subscription",
    {
      // Encerrar uma cobrança recorrente mexe no dinheiro de outra pessoa: exige admin+, a
      // mesma fronteira do reembolso. Quem doou continua podendo cancelar pela própria conta;
      // isto é a saída para quem perdeu acesso ao e-mail e ligou para a loja.
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "cancelStoreDonationSubscription",
        tags: ["donations"],
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        response: { 202: CancelSubscriptionResponse },
      },
    },
    async (req, reply) => {
      const store = await resolveStoreForRole(req, "admin");
      requireWritableStore(req, store);
      const { id } = req.params as { id: string };
      const donation = await repo.findByIdForStore(id, store.id);
      if (!donation) throw new NotFoundError("donation_not_found");
      await cancelDonationSubscription({ donations: repo, stripe: app.gateways.stripe }, donation);
      void reply.code(202).send({ status: "subscription_cancelled" });
    },
  );
};
