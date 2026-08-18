import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { createBillingRepository, toBillingStatusResponse } from "../billing.repository.js";
import { BillingStatusResponse } from "../billing.schema.js";

const Params = z.object({ slug: z.string() });

export const getBillingStatusRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/stores/:slug/billing",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "getBillingStatus",
        tags: ["billing"],
        params: Params,
        response: { 200: BillingStatusResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "admin");
      return toBillingStatusResponse(await createBillingRepository(db).findByStoreId(store.id));
    },
  );
};
