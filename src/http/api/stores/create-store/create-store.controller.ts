import type { FastifyPluginAsync } from "fastify";
import { db } from "../../../../infra/db/client.js";
import { requireUser } from "../../../hooks/auth.js";
import { createStoresRepository, toStoreResponse } from "../stores.repository.js";
import { CreateStoreBody, StoreResponse } from "../stores.schema.js";
import { createCreateStoreService } from "./create-store.service.js";

export const createStoreRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/stores",
    {
      config: { permissions: { any: ["customer"] }, rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        operationId: "createStore",
        tags: ["stores"],
        body: CreateStoreBody,
        response: { 201: StoreResponse },
      },
    },
    async (req, reply) => {
      const { sub } = requireUser(req);
      const service = createCreateStoreService({ repo: createStoresRepository(db) });
      const store = await service({ ...(req.body as CreateStoreBody), userId: sub });
      void reply.code(201).send(toStoreResponse(store, app.gateways.r2.publicUrl));
    },
  );
};
