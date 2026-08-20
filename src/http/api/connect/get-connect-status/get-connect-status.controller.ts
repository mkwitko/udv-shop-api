import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { toConnectStatusResponse } from "../connect.helpers.js";
import { ConnectStatusResponse } from "../connect.schema.js";

const Params = z.object({ slug: z.string() });

export const getConnectStatusRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/stores/:slug/connect",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "getConnectStatus",
        tags: ["connect"],
        params: Params,
        response: { 200: ConnectStatusResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "admin");
      // Enquanto o onboarding não foi submetido, o valor no banco envelhece a cada passo
      // que o núcleo dá no Stripe e é exatamente essa a tela que ele fica olhando. Depois
      // de `detailsSubmitted`, o account.updated mantém o banco em dia e não gastamos
      // chamada nenhuma.
      if (store.stripeAccountId && !store.stripeDetailsSubmitted) {
        const caps = await app.gateways.stripe.retrieveAccountStatus(store.stripeAccountId);
        await createStoresRepository(db).setStripeCapabilities(store.stripeAccountId, caps);
        return toConnectStatusResponse({
          ...store,
          stripeTransfersEnabled: caps.transfersEnabled,
          stripeChargesEnabled: caps.chargesEnabled,
          stripePayoutsEnabled: caps.payoutsEnabled,
          stripeDetailsSubmitted: caps.detailsSubmitted,
        });
      }
      return toConnectStatusResponse(store);
    },
  );
};
