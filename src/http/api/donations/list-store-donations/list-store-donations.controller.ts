import type { FastifyPluginAsync } from "fastify";
import type { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { createCampaignsRepository } from "../../campaigns/campaigns.repository.js";
import { createDonationsRepository, toStoreDonationResponse } from "../donations.repository.js";
import { StoreDonationsPageResponse, StoreDonationsQuery } from "../donations.schema.js";
import { resolveStoreForRole } from "../manage.helpers.js";

export const listStoreDonationsRoute: FastifyPluginAsync = async (app) => {
  const repo = createDonationsRepository(db);
  app.get(
    "/stores/:slug/donations",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "listStoreDonations",
        tags: ["donations"],
        querystring: StoreDonationsQuery,
        response: { 200: StoreDonationsPageResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "staff");
      const { limit, cursor, status, campaignSlug } = req.query as z.infer<
        typeof StoreDonationsQuery
      >;
      let campaignId: string | null = null;
      if (campaignSlug !== undefined) {
        const campaign = await createCampaignsRepository(db).findBySlug(store.id, campaignSlug);
        if (!campaign) throw new NotFoundError("campaign_not_found");
        campaignId = campaign.id;
      }
      const page = await repo.listByStoreCursor({
        storeId: store.id,
        campaignId,
        status: status ?? null,
        limit,
        cursor: cursor ?? null,
      });
      return { items: page.items.map(toStoreDonationResponse), nextCursor: page.nextCursor };
    },
  );
};
