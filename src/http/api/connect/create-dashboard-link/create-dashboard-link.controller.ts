import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ConflictError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { DashboardLinkResponse } from "../connect.schema.js";

const Params = z.object({ slug: z.string() });

/**
 * Substitui o dashboard completo que a conta Standard dava ao núcleo: com controller
 * properties de Express o acesso é por login link de uso único gerado pela plataforma
 * (ver ADR-024). Sem conta conectada, ou com onboarding ainda incompleto, o Stripe
 * recusa o link — barramos antes para o núcleo ver o motivo em vez de um 502.
 */
export const createDashboardLinkRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/stores/:slug/connect/stripe/dashboard",
    {
      config: {
        permissions: { any: ["store_owner", "store_admin"] },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      schema: {
        operationId: "createStripeDashboardLink",
        tags: ["connect"],
        params: Params,
        response: { 201: DashboardLinkResponse },
      },
    },
    async (req, reply) => {
      const store = await resolveStoreForRole(req, "admin");
      requireWritableStore(req, store);
      if (!store.stripeAccountId || !store.stripeDetailsSubmitted) {
        throw new ConflictError("stripe_onboarding_incomplete");
      }
      const link = await app.gateways.stripe.createExpressDashboardLink(store.stripeAccountId);
      void reply.code(201).send({ url: link.url });
    },
  );
};
