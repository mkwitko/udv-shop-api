import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { optionalUser } from "../../../hooks/optional-user.js";
import { assertStoreReadable } from "../../stores/store-visibility.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import {
  createProductCategoriesRepository,
  toCategoryResponse,
} from "../product-categories.repository.js";
import { CategoriesResponse } from "../product-categories.schema.js";

const Params = z.object({ slug: z.string() });

export const listCategoriesRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/stores/:slug/categories",
    {
      config: { public: true },
      schema: {
        operationId: "listCategories",
        tags: ["products"],
        params: Params,
        response: { 200: CategoriesResponse },
      },
    },
    async (req) => {
      const store = await createStoresRepository(db).findBySlug(
        (req.params as z.infer<typeof Params>).slug,
      );
      assertStoreReadable(store, await optionalUser(req));
      const { items, total } = await createProductCategoriesRepository(db).listByStore(store.id);
      // categoria sem produto ativo continua na resposta: a gestão precisa dela na lista,
      // e é a vitrine que decide não desenhar uma gaveta vazia
      return { items: items.map(toCategoryResponse), total };
    },
  );
};
