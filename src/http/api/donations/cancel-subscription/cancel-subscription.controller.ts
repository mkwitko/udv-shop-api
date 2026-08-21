import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireUser } from "../../../hooks/auth.js";
import { createDonationsRepository } from "../donations.repository.js";
import { CancelSubscriptionResponse } from "../donations.schema.js";
import { cancelDonationSubscription } from "./cancel-subscription.service.js";

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
      await cancelDonationSubscription({ donations: repo, stripe: app.gateways.stripe }, donation);
      void reply.code(202).send({ status: "subscription_cancelled" });
    },
  );
};
