import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../../../../config/env.js";
import { db } from "../../../../infra/db/client.js";
import { ConflictError } from "../../../../shared/errors.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { createBillingRepository } from "../billing.repository.js";
import { BillingLinkResponse } from "../billing.schema.js";

const Params = z.object({ slug: z.string() });

export const createBillingPortalRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/stores/:slug/billing/portal",
    {
      config: {
        permissions: { any: ["store_owner"] },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      schema: {
        operationId: "createBillingPortal",
        tags: ["billing"],
        params: Params,
        response: { 201: BillingLinkResponse },
      },
    },
    async (req, reply) => {
      const store = await resolveStoreForRole(req, "owner");
      const subscription = await createBillingRepository(db).findByStoreId(store.id);
      // Portal do Stripe é por customer: sem checkout nenhum feito, não há o que gerir.
      if (!subscription) throw new ConflictError("no_subscription");
      const session = await app.gateways.stripe.createBillingPortalSession({
        customerId: subscription.stripeCustomerId,
        returnUrl: `${env.WEB_ORIGIN}/gestao/${store.slug}`,
      });
      void reply.code(201).send({ url: session.url });
    },
  );
};
