import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ConflictError } from "../../../../shared/errors.js";
import { requireUser } from "../../../hooks/auth.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { AccountSessionResponse } from "../connect.schema.js";

const Params = z.object({ slug: z.string() });

/**
 * Client secret dos componentes embutidos (onboarding + notification banner) que o
 * /gestao renderiza no lugar do redirect hospedado — ver ADR-026. Cria a conta conectada
 * na primeira chamada, como a rota de account link faz, para o núcleo entrar no
 * onboarding sem passar por dois pedidos.
 */
export const createAccountSessionRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/stores/:slug/connect/stripe/account-session",
    {
      config: {
        permissions: { any: ["store_owner"] },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      schema: {
        operationId: "createStripeAccountSession",
        tags: ["connect"],
        params: Params,
        response: { 201: AccountSessionResponse },
      },
    },
    async (req, reply) => {
      const store = await resolveStoreForRole(req, "owner");
      requireWritableStore(req, store);
      const repo = createStoresRepository(db);

      let accountId = store.stripeAccountId;
      if (!accountId) {
        const { sub } = requireUser(req);
        const user = await db.user.findUniqueOrThrow({
          where: { id: sub },
          select: { email: true },
        });
        const created = await app.gateways.stripe.createConnectedAccount({
          email: user.email,
          storeName: store.name,
        });
        accountId = created.accountId;
        // Persistido antes da sessão: se a sessão falhar, o retry reusa a conta em vez de
        // criar uma segunda para o mesmo núcleo.
        await repo.attachStripeAccount(store.id, accountId);
      }

      const session = await app.gateways.stripe.createAccountSession(accountId);
      if (!session.clientSecret) throw new ConflictError("stripe_session_unavailable");
      void reply.code(201).send({ clientSecret: session.clientSecret });
    },
  );
};
