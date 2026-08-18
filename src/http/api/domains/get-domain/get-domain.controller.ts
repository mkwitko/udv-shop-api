import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { resolveStoreForRole } from "../../stores/manage.helpers.js";
import { toDomainStatus } from "../domains.helpers.js";
import { DomainStatusResponse } from "../domains.schema.js";

export const getDomainRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/stores/:slug/domain",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "getStoreDomain",
        tags: ["domains"],
        params: z.object({ slug: z.string() }),
        response: { 200: DomainStatusResponse },
      },
    },
    async (req) => toDomainStatus(await resolveStoreForRole(req, "admin")),
  );
};
