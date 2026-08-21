import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ConflictError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { assertUniquePrizePositions } from "../../raffles/raffles.schema.js";
import { createCampaignsRepository, toCampaignResponse } from "../campaigns.repository.js";
import { CampaignResponse, CreateCampaignBody } from "../campaigns.schema.js";
import { assertCoverInGallery, resolveStoreForRole } from "../manage.helpers.js";

export const createCampaignRoute: FastifyPluginAsync = async (app) => {
  const repo = createCampaignsRepository(db);
  app.post(
    "/stores/:slug/campaigns",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "createCampaign",
        tags: ["campaigns"],
        params: z.object({ slug: z.string() }),
        body: CreateCampaignBody,
        response: { 201: CampaignResponse },
      },
    },
    async (req, reply) => {
      const store = await resolveStoreForRole(req, "admin");
      requireWritableStore(req, store);
      const body = req.body as CreateCampaignBody;
      if (body.raffle) assertUniquePrizePositions(body.raffle.prizes);
      assertCoverInGallery(body.coverImage, body.images, { coverImage: null, images: [] });
      const existing = await repo.findBySlug(store.id, body.slug);
      if (existing) throw new ConflictError("campaign_slug_taken");
      const campaign = await repo.create(store.id, body);
      void reply.code(201).send(toCampaignResponse(campaign, undefined, app.gateways.r2.publicUrl));
    },
  );
};
