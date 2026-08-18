import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../../../../config/env.js";
import { db } from "../../../../infra/db/client.js";
import { ConflictError } from "../../../../shared/errors.js";
import { requireUser } from "../../../hooks/auth.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { createBillingRepository } from "../billing.repository.js";
import { BillingLinkResponse } from "../billing.schema.js";

const Params = z.object({ slug: z.string() });

export const createBillingCheckoutRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/stores/:slug/billing/checkout",
    {
      config: {
        permissions: { any: ["store_owner"] },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      schema: {
        operationId: "createBillingCheckout",
        tags: ["billing"],
        params: Params,
        response: { 201: BillingLinkResponse },
      },
    },
    async (req, reply) => {
      // Sem `requireWritableStore`: loja suspensa por falta de pagamento precisa
      // justamente poder assinar de novo. A ativação continua sendo do platform_admin
      // quando a suspensão foi de moderação — ver billing.repository.
      const store = await resolveStoreForRole(req, "owner");
      if (env.STRIPE_SAAS_PRICE_ID.length === 0) {
        throw new ConflictError("billing_not_configured");
      }
      const repo = createBillingRepository(db);
      const current = await repo.findByStoreId(store.id);
      if (current && (current.status === "active" || current.status === "trialing")) {
        throw new ConflictError("subscription_already_active");
      }

      const { sub } = requireUser(req);
      const user = await db.user.findUniqueOrThrow({ where: { id: sub }, select: { email: true } });
      const base = `${env.WEB_ORIGIN}/gestao/${store.slug}`;
      const session = await app.gateways.stripe.createSaasCheckoutSession({
        priceId: env.STRIPE_SAAS_PRICE_ID,
        // Reusar o customer mantém histórico e método de pagamento entre tentativas.
        customerId: current?.stripeCustomerId ?? null,
        customerEmail: user.email,
        storeId: store.id,
        successUrl: `${base}?assinatura=ok`,
        cancelUrl: `${base}?assinatura=cancelada`,
      });
      void reply.code(201).send({ url: session.url });
    },
  );
};
