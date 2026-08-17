import type { FastifyPluginAsync } from "fastify";
import { db } from "../../../../infra/db/client.js";
import { createStoresRepository, toStoreResponse } from "../stores.repository.js";
import { ListStoresQuery, StoresPageResponse } from "../stores.schema.js";

export const listStoresRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/stores",
    {
      config: { public: true },
      schema: {
        operationId: "listStores",
        tags: ["stores"],
        querystring: ListStoresQuery,
        response: { 200: StoresPageResponse },
      },
    },
    async (req) => {
      const { limit, cursor } = req.query as ListStoresQuery;
      const page = await createStoresRepository(db).listActiveByCursor(limit, cursor ?? null);
      return { items: page.items.map(toStoreResponse), nextCursor: page.nextCursor };
    },
  );
};
