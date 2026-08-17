import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireStoreRole, requireWritableStore } from "../../../hooks/store-role.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { createProductsRepository } from "../products.repository.js";

const Params = z.object({ slug: z.string(), productSlug: z.string() });

export const archiveProductRoute: FastifyPluginAsync = async (app) => {
  app.delete(
    "/stores/:slug/products/:productSlug",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "archiveProduct",
        tags: ["products"],
        params: Params,
        response: { 204: z.null().describe("No Content") },
      },
    },
    async (req, reply) => {
      const { slug, productSlug } = req.params as z.infer<typeof Params>;
      const store = await createStoresRepository(db).findBySlug(slug);
      if (!store) throw new NotFoundError("store not found");
      requireStoreRole(req, store.id, "staff");
      requireWritableStore(req, store);
      const repo = createProductsRepository(db);
      const product = await repo.findBySlug(store.id, productSlug);
      if (!product) throw new NotFoundError("product not found");
      await repo.archive(product.id);
      void reply.code(204).send();
    },
  );
};
