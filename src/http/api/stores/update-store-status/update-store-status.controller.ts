import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { createStoresRepository, toStoreResponse } from "../stores.repository.js";
import { StoreResponse, UpdateStoreStatusBody } from "../stores.schema.js";

const Params = z.object({ slug: z.string() });

export const updateStoreStatusRoute: FastifyPluginAsync = async (app) => {
  app.patch(
    "/stores/:slug/status",
    {
      config: { permissions: { any: ["platform_admin"] } },
      schema: {
        operationId: "updateStoreStatus",
        tags: ["stores"],
        params: Params,
        body: UpdateStoreStatusBody,
        response: { 200: StoreResponse },
      },
    },
    async (req) => {
      const repo = createStoresRepository(db);
      const store = await repo.findBySlug((req.params as z.infer<typeof Params>).slug);
      if (!store) throw new NotFoundError("store not found");
      const { status } = req.body as UpdateStoreStatusBody;
      return toStoreResponse(await repo.setStatus(store.id, status), app.gateways.r2.publicUrl);
    },
  );
};
