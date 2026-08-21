import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { optionalUser } from "../../../hooks/optional-user.js";
import { assertStoreReadable } from "../store-visibility.js";
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
      // Suspensa continua legível: a página pública precisa dizer que está fora do ar.
      assertStoreReadable(store, await optionalUser(req));
      return toStoreResponse(store, app.gateways.r2.publicUrl);
    },
  );
};
