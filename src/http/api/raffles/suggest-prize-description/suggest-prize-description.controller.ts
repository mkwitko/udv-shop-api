import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ServiceUnavailableError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { SuggestPrizeDescriptionBody, SuggestPrizeDescriptionResponse } from "../raffles.schema.js";

const Params = z.object({ slug: z.string() });

/**
 * Sugestão de descrição do prêmio. Igual às outras: devolve texto e não grava. A rota não
 * exige campanha nem sorteio criados porque o campo aparece já na criação da campanha.
 */
export const suggestPrizeDescriptionRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/stores/:slug/campaigns/prize-description-suggestion",
    {
      config: {
        permissions: { any: ["store_owner", "store_admin"] },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      schema: {
        operationId: "suggestPrizeDescription",
        tags: ["raffles"],
        params: Params,
        body: SuggestPrizeDescriptionBody,
        response: { 200: SuggestPrizeDescriptionResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "admin");
      requireWritableStore(req, store);
      if (!app.gateways.ai.configured) throw new ServiceUnavailableError("ai_not_configured");

      const body = req.body as SuggestPrizeDescriptionBody;
      const text = await app.gateways.ai.writePrizeDescription({
        prizeTitle: body.prizeTitle,
        campaignTitle: body.campaignTitle,
        draft: body.draft,
        mode: body.mode,
        storeName: store.name,
      });
      return { text };
    },
  );
};
