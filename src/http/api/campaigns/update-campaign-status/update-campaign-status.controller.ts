import type { CampaignStatus } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ConflictError, NotFoundError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { createCampaignsRepository, toCampaignResponse } from "../campaigns.repository.js";
import { CampaignResponse, UpdateCampaignStatusBody } from "../campaigns.schema.js";
import { resolveStoreForRole } from "../manage.helpers.js";

// Rascunho pode ir ao ar; no ar pode pausar ou encerrar; pausada volta ou encerra.
// "finished" é terminal: reabrir campanha encerrada confunde quem já doou.
const ALLOWED: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ["active"],
  active: ["paused", "finished"],
  paused: ["active", "finished"],
  finished: [],
};

export const updateCampaignStatusRoute: FastifyPluginAsync = async (app) => {
  const repo = createCampaignsRepository(db);
  app.patch(
    "/stores/:slug/campaigns/:campaignSlug/status",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "updateCampaignStatus",
        tags: ["campaigns"],
        params: z.object({ slug: z.string(), campaignSlug: z.string() }),
        body: UpdateCampaignStatusBody,
        response: { 200: CampaignResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "admin");
      requireWritableStore(req, store);
      const { campaignSlug } = req.params as { campaignSlug: string };
      const { status } = req.body as z.infer<typeof UpdateCampaignStatusBody>;
      const current = await repo.findBySlug(store.id, campaignSlug);
      if (!current) throw new NotFoundError("campaign_not_found");
      if (current.status === status) {
        const progress = await repo.progressFor([current.id]);
        return toCampaignResponse(current, progress.get(current.id), app.gateways.r2.publicUrl);
      }
      if (!ALLOWED[current.status].includes(status)) {
        throw new ConflictError("invalid_campaign_transition");
      }
      const campaign = await repo.setStatus(current.id, status);
      const progress = await repo.progressFor([campaign.id]);
      return toCampaignResponse(campaign, progress.get(campaign.id), app.gateways.r2.publicUrl);
    },
  );
};
