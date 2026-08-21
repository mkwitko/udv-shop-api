import type { FastifyPluginAsync } from "fastify";
import type { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireStoreRole, requireWritableStore } from "../../../hooks/store-role.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import {
  createProductCategoriesRepository,
  toCategoryWriteResponse,
} from "../product-categories.repository.js";
import {
  CategoryIdParams,
  CategoryResponse,
  UpdateCategoryBody,
} from "../product-categories.schema.js";

export const updateCategoryRoute: FastifyPluginAsync = async (app) => {
  app.patch(
    "/stores/:slug/categories/:id",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "updateCategory",
        tags: ["products"],
        params: CategoryIdParams,
        body: UpdateCategoryBody,
        response: { 200: CategoryResponse },
      },
    },
    async (req) => {
      const { slug, id } = req.params as z.infer<typeof CategoryIdParams>;
      const store = await createStoresRepository(db).findBySlug(slug);
      if (!store) throw new NotFoundError("store_not_found");
      requireStoreRole(req, store.id, "staff");
      requireWritableStore(req, store);
      const { name } = req.body as UpdateCategoryBody;
      // rename filtra por (id, storeId): categoria de outra loja não é achada aqui
      const category = await createProductCategoriesRepository(db).rename(store.id, id, name);
      return toCategoryWriteResponse(category);
    },
  );
};
