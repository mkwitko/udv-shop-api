import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireStoreRole, requireWritableStore } from "../../../hooks/store-role.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { createProductCategoriesRepository } from "../product-categories.repository.js";
import { CategoryIdParams } from "../product-categories.schema.js";

export const deleteCategoryRoute: FastifyPluginAsync = async (app) => {
  app.delete(
    "/stores/:slug/categories/:id",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "deleteCategory",
        tags: ["products"],
        params: CategoryIdParams,
        response: { 204: z.null().describe("No Content") },
      },
    },
    async (req, reply) => {
      const { slug, id } = req.params as z.infer<typeof CategoryIdParams>;
      const store = await createStoresRepository(db).findBySlug(slug);
      if (!store) throw new NotFoundError("store_not_found");
      requireStoreRole(req, store.id, "staff");
      requireWritableStore(req, store);
      await createProductCategoriesRepository(db).remove(store.id, id);
      void reply.code(204).send();
    },
  );
};
