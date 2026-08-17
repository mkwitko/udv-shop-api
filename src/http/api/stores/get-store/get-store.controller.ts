import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { optionalUser } from "../../../hooks/optional-user.js";
import { createStoresRepository, toStoreResponse } from "../stores.repository.js";
import { StoreResponse } from "../stores.schema.js";

const Params = z.object({ slug: z.string() });

export const getStoreRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/stores/:slug",
    {
      config: { public: true },
      schema: {
        operationId: "getStore",
        tags: ["stores"],
        params: Params,
        response: { 200: StoreResponse },
      },
    },
    async (req) => {
      const { slug } = req.params as z.infer<typeof Params>;
      const store = await createStoresRepository(db).findBySlug(slug);
      if (!store) throw new NotFoundError(`store ${slug} not found`);
      if (store.status !== "active") {
        const user = await optionalUser(req);
        const canSee = user && (user.platformAdmin || user.roles[store.id]);
        if (!canSee) throw new NotFoundError(`store ${slug} not found`);
      }
      return toStoreResponse(store);
    },
  );
};
