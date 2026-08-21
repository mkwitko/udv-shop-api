import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireStoreRole, requireWritableStore } from "../../../hooks/store-role.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import {
  createProductCategoriesRepository,
  toCategoryResponse,
} from "../product-categories.repository.js";
import { CategoriesResponse, ReorderCategoriesBody } from "../product-categories.schema.js";

const Params = z.object({ slug: z.string() });

export const reorderCategoriesRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/stores/:slug/categories/reorder",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "reorderCategories",
        tags: ["products"],
        params: Params,
        body: ReorderCategoriesBody,
        response: { 200: CategoriesResponse },
      },
    },
    async (req) => {
      const store = await createStoresRepository(db).findBySlug(
        (req.params as z.infer<typeof Params>).slug,
      );
      if (!store) throw new NotFoundError("store_not_found");
      requireStoreRole(req, store.id, "staff");
      requireWritableStore(req, store);
      const { ids } = req.body as ReorderCategoriesBody;
      const repo = createProductCategoriesRepository(db);
      // lista com id de fora da loja é recusada inteira: nada é movido pela metade
      await repo.reorder(store.id, ids);
      const { items, total } = await repo.listByStore(store.id);
      return { items: items.map(toCategoryResponse), total };
    },
  );
};
