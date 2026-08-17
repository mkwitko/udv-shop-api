import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireStoreRole, requireWritableStore } from "../../../hooks/store-role.js";
import { createStoresRepository, toStoreResponse } from "../stores.repository.js";
import { StoreResponse, UpdateStoreBody } from "../stores.schema.js";

const Params = z.object({ slug: z.string() });

export const updateStoreRoute: FastifyPluginAsync = async (app) => {
  app.patch(
    "/stores/:slug",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "updateStore",
        tags: ["stores"],
        params: Params,
        body: UpdateStoreBody,
        response: { 200: StoreResponse },
      },
    },
    async (req) => {
      const repo = createStoresRepository(db);
      const store = await repo.findBySlug((req.params as z.infer<typeof Params>).slug);
      if (!store) throw new NotFoundError("store not found");
      requireStoreRole(req, store.id, "admin");
      requireWritableStore(req, store);
      const updated = await repo.update(store.id, req.body as UpdateStoreBody);
      return toStoreResponse(updated);
    },
  );
};
