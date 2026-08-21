import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ConflictError, NotFoundError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { createCampaignsRepository, toCampaignResponse } from "../campaigns.repository.js";
import { ArchiveCampaignBody, CampaignResponse } from "../campaigns.schema.js";
import { resolveStoreForRole } from "../manage.helpers.js";

/**
 * Arquivar é sobre a lista, não sobre a campanha: o histórico continua inteiro e o link
 * que já foi compartilhado continua abrindo. Só campanha encerrada arquiva — sumir com
 * uma que ainda recebe doação esconderia dinheiro entrando.
 */
export const archiveCampaignRoute: FastifyPluginAsync = async (app) => {
  const repo = createCampaignsRepository(db);
  app.patch(
    "/stores/:slug/campaigns/:campaignSlug/archive",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "archiveCampaign",
        tags: ["campaigns"],
        params: z.object({ slug: z.string(), campaignSlug: z.string() }),
        body: ArchiveCampaignBody,
        response: { 200: CampaignResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "admin");
      requireWritableStore(req, store);
      const { campaignSlug } = req.params as { campaignSlug: string };
      const { archived } = req.body as ArchiveCampaignBody;
      const current = await repo.findBySlug(store.id, campaignSlug);
      if (!current) throw new NotFoundError("campaign_not_found");
      if (archived && current.status !== "finished") {
        throw new ConflictError("campaign_not_finished");
      }
      const campaign = await repo.setArchived(current.id, archived);
      const progress = await repo.progressFor([campaign.id]);
      return toCampaignResponse(campaign, progress.get(campaign.id), app.gateways.r2.publicUrl);
    },
  );
};
