import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { createCampaignsRepository, toCampaignResponse } from "../campaigns.repository.js";
import { CampaignResponse, UpdateCampaignBody } from "../campaigns.schema.js";
import { resolveStoreForRole } from "../manage.helpers.js";

export const updateCampaignRoute: FastifyPluginAsync = async (app) => {
  const repo = createCampaignsRepository(db);
  app.patch(
    "/stores/:slug/campaigns/:campaignSlug",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "updateCampaign",
        tags: ["campaigns"],
        params: z.object({ slug: z.string(), campaignSlug: z.string() }),
        body: UpdateCampaignBody,
        response: { 200: CampaignResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "admin");
      requireWritableStore(req, store);
      const { campaignSlug } = req.params as { campaignSlug: string };
      const current = await repo.findBySlug(store.id, campaignSlug);
      if (!current) throw new NotFoundError("campaign_not_found");
      // Slug é imutável (mesma decisão de produto — ADR-007): link público de campanha
      // circula em rede social e não pode quebrar.
      const campaign = await repo.update(current.id, req.body as UpdateCampaignBody);
      const progress = await repo.progressFor([campaign.id]);
      return toCampaignResponse(campaign, progress.get(campaign.id), app.gateways.r2.publicUrl);
    },
  );
};
