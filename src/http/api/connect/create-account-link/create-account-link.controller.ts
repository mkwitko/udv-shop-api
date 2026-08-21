import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ValidationError } from "../../../../shared/errors.js";
import { requireUser } from "../../../hooks/auth.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { connectUrls } from "../connect.helpers.js";
import { OnboardingLinkResponse } from "../connect.schema.js";

const Params = z.object({ slug: z.string() });

export const createAccountLinkRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/stores/:slug/connect/stripe/link",
    {
      config: {
        permissions: { any: ["store_owner"] },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      schema: {
        operationId: "createStripeAccountLink",
        tags: ["connect"],
        params: Params,
        response: { 201: OnboardingLinkResponse },
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
        // A conta conectada nasce no nome de quem responde pela loja, e o Stripe exige um
        // e-mail para ela. Conta leve não abre conta conectada.
        if (!user.email) throw new ValidationError("email_required");
        const created = await app.gateways.stripe.createConnectedAccount({
          email: user.email,
          storeName: store.name,
        });
        accountId = created.accountId;
        // Persistido antes de gerar o link: se a criação do link falhar, o retry reusa a
        // conta em vez de criar uma segunda conta conectada para o mesmo núcleo.
        await repo.attachStripeAccount(store.id, accountId);
      }

      const { refreshUrl, returnUrl } = connectUrls(store.slug);
      const link = await app.gateways.stripe.createAccountLink({
        accountId,
        refreshUrl,
        returnUrl,
      });
      void reply.code(201).send({ url: link.url });
    },
  );
};
