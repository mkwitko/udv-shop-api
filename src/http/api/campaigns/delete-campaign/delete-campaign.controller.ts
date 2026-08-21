import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ConflictError, NotFoundError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { createCampaignsRepository } from "../campaigns.repository.js";
import { resolveStoreForRole } from "../manage.helpers.js";

/**
 * Apagar de vez só vale para rascunho: campanha que chegou a ficar no ar tem história
 * pública, link compartilhado e doação atrás dela — para essa o caminho é encerrar.
 */
export const deleteCampaignRoute: FastifyPluginAsync = async (app) => {
  const repo = createCampaignsRepository(db);
  app.delete(
    "/stores/:slug/campaigns/:campaignSlug",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "deleteCampaign",
        tags: ["campaigns"],
        params: z.object({ slug: z.string(), campaignSlug: z.string() }),
        response: { 204: z.null().describe("No Content") },
      },
    },
    async (req, reply) => {
      const store = await resolveStoreForRole(req, "admin");
      requireWritableStore(req, store);
      const { campaignSlug } = req.params as { campaignSlug: string };
      const campaign = await repo.findBySlug(store.id, campaignSlug);
      if (!campaign) throw new NotFoundError("campaign_not_found");
      if (campaign.status !== "draft") throw new ConflictError("campaign_not_draft");
      // Rascunho não é público, então não deveria ter doação. Conferir antes evita que o
      // `onDelete: Restrict` da doação vire erro de banco no lugar de uma resposta clara.
      if ((await repo.countDonations(campaign.id)) > 0) {
        throw new ConflictError("campaign_has_donations");
      }
      await repo.deleteById(campaign.id);
      void reply.code(204).send();
    },
  );
};
