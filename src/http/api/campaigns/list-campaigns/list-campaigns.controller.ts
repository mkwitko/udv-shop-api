import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { optionalUser } from "../../../hooks/optional-user.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { createCampaignsRepository, toCampaignResponse } from "../campaigns.repository.js";
import { CampaignsPageResponse, ListCampaignsQuery } from "../campaigns.schema.js";
import { isStoreMember } from "../manage.helpers.js";

const Params = z.object({ slug: z.string() });

export const listCampaignsRoute: FastifyPluginAsync = async (app) => {
  const repo = createCampaignsRepository(db);
  app.get(
    "/stores/:slug/campaigns",
    {
      config: { public: true },
      schema: {
        operationId: "listCampaigns",
        tags: ["campaigns"],
        params: Params,
        querystring: ListCampaignsQuery,
        response: { 200: CampaignsPageResponse },
      },
    },
    async (req) => {
      const store = await createStoresRepository(db).findBySlug(
        (req.params as z.infer<typeof Params>).slug,
      );
      const user = await optionalUser(req);
      const member = isStoreMember(user, store?.id);
      if (!store || (store.status !== "active" && !member)) {
        throw new NotFoundError("store_not_found");
      }
      const { limit, cursor, all } = req.query as ListCampaignsQuery;
      const page = await repo.listByStoreCursor({
        storeId: store.id,
        limit,
        cursor: cursor ?? null,
        includeDrafts: all && member,
      });
      const progress = await repo.progressFor(page.items.map((c) => c.id));
      return {
        items: page.items.map((c) =>
          toCampaignResponse(c, progress.get(c.id), app.gateways.r2.publicUrl),
        ),
        nextCursor: page.nextCursor,
      };
    },
  );
};
