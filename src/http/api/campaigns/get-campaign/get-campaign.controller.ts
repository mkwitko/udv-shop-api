import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { optionalUser } from "../../../hooks/optional-user.js";
import { assertStoreReadable, isStoreMember } from "../../stores/store-visibility.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { createCampaignsRepository, toCampaignResponse } from "../campaigns.repository.js";
import { CampaignResponse } from "../campaigns.schema.js";

const Params = z.object({ slug: z.string(), campaignSlug: z.string() });

export const getCampaignRoute: FastifyPluginAsync = async (app) => {
  const repo = createCampaignsRepository(db);
  app.get(
    "/stores/:slug/campaigns/:campaignSlug",
    {
      config: { public: true },
      schema: {
        operationId: "getCampaign",
        tags: ["campaigns"],
        params: Params,
        response: { 200: CampaignResponse },
      },
    },
    async (req) => {
      const { slug, campaignSlug } = req.params as z.infer<typeof Params>;
      const store = await createStoresRepository(db).findBySlug(slug);
      const user = await optionalUser(req);
      assertStoreReadable(store, user);
      const member = isStoreMember(user, store.id);
      const campaign = await repo.findBySlug(store.id, campaignSlug);
      // Rascunho é 404 para quem não é da loja — não vaza nem a existência.
      if (!campaign || (campaign.status === "draft" && !member)) {
        throw new NotFoundError("campaign_not_found");
      }
      const progress = await repo.progressFor([campaign.id]);
      return toCampaignResponse(campaign, progress.get(campaign.id), app.gateways.r2.publicUrl);
    },
  );
};
