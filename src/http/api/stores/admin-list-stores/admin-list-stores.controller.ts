import type { FastifyPluginAsync } from "fastify";
import { db } from "../../../../infra/db/client.js";
import { createStoresRepository, toStoreResponse } from "../stores.repository.js";
import { AdminListStoresQuery, StoresPageResponse } from "../stores.schema.js";

export const adminListStoresRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/admin/stores",
    {
      config: { permissions: { any: ["platform_admin"] } },
      schema: {
        operationId: "adminListStores",
        tags: ["stores"],
        querystring: AdminListStoresQuery,
        response: { 200: StoresPageResponse },
      },
    },
    async (req) => {
      const { limit, cursor, status } = req.query as AdminListStoresQuery;
      const page = await createStoresRepository(db).listAllByCursor(limit, cursor ?? null, status);
      return {
        items: page.items.map((store) => toStoreResponse(store, app.gateways.r2.publicUrl)),
        nextCursor: page.nextCursor,
      };
    },
  );
};
