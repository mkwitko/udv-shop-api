import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ServiceUnavailableError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { SuggestStoryBody, SuggestStoryResponse } from "../campaigns.schema.js";
import { resolveStoreForRole } from "../manage.helpers.js";

const Params = z.object({ slug: z.string() });

/**
 * Sugestão de história de campanha escrita pela IA. Igual à de produto: devolve texto,
 * não grava. Pedir doação com texto que a comunidade não revisou seria pior que texto
 * mal escrito, então quem aplica é sempre a pessoa.
 */
export const suggestStoryRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/stores/:slug/campaigns/story-suggestion",
    {
      config: {
        permissions: { any: ["store_owner", "store_admin"] },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      schema: {
        operationId: "suggestCampaignStory",
        tags: ["campaigns"],
        params: Params,
        body: SuggestStoryBody,
        response: { 200: SuggestStoryResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "admin");
      requireWritableStore(req, store);
      if (!app.gateways.ai.configured) throw new ServiceUnavailableError("ai_not_configured");

      const body = req.body as SuggestStoryBody;
      const text = await app.gateways.ai.writeCampaignStory({
        campaignTitle: body.title,
        draft: body.draft,
        mode: body.mode,
        storeName: store.name,
      });
      return { text };
    },
  );
};
