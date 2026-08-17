import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { createInterestsRepository } from "../interests.repository.js";
import { DEMAND_MAX_PRODUCTS, InterestDemandResponse } from "../interests.schema.js";
import { resolveStoreForRole } from "../manage.helpers.js";

export const interestDemandRoute: FastifyPluginAsync = async (app) => {
  const repo = createInterestsRepository(db);
  app.get(
    "/stores/:slug/interests/demand",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "getInterestDemand",
        tags: ["interests"],
        params: z.object({ slug: z.string() }),
        response: { 200: InterestDemandResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "staff");
      const rows = await repo.aggregateDemand(store.id);
      return { items: rows.slice(0, DEMAND_MAX_PRODUCTS) };
    },
  );
};
