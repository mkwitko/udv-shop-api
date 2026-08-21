import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireStoreRole, requireWritableStore } from "../../../hooks/store-role.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import {
  createProductCategoriesRepository,
  toCategoryWriteResponse,
} from "../product-categories.repository.js";
import { CategoryResponse, CreateCategoryBody } from "../product-categories.schema.js";

const Params = z.object({ slug: z.string() });

export const createCategoryRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/stores/:slug/categories",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "createCategory",
        tags: ["products"],
        params: Params,
        body: CreateCategoryBody,
        response: { 201: CategoryResponse },
      },
    },
    async (req, reply) => {
      const store = await createStoresRepository(db).findBySlug(
        (req.params as z.infer<typeof Params>).slug,
      );
      if (!store) throw new NotFoundError("store_not_found");
      requireStoreRole(req, store.id, "staff");
      requireWritableStore(req, store);
      const { name } = req.body as CreateCategoryBody;
      const category = await createProductCategoriesRepository(db).create(store.id, name);
      void reply.code(201).send(toCategoryWriteResponse(category));
    },
  );
};
