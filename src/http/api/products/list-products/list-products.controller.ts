import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { optionalUser } from "../../../hooks/optional-user.js";
import { assertStoreReadable, isStoreMember } from "../../stores/store-visibility.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { createProductsRepository, toProductResponse } from "../products.repository.js";
import { ListProductsQuery, ProductsPageResponse } from "../products.schema.js";

const Params = z.object({ slug: z.string() });

export const listProductsRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/stores/:slug/products",
    {
      config: { public: true },
      schema: {
        operationId: "listProducts",
        tags: ["products"],
        params: Params,
        querystring: ListProductsQuery,
        response: { 200: ProductsPageResponse },
      },
    },
    async (req) => {
      const store = await createStoresRepository(db).findBySlug(
        (req.params as z.infer<typeof Params>).slug,
      );
      const user = await optionalUser(req);
      assertStoreReadable(store, user);
      const isMember = isStoreMember(user, store.id);
      const { limit, cursor, all } = req.query as ListProductsQuery;
      const page = await createProductsRepository(db).listByStoreCursor({
        storeId: store.id,
        limit,
        cursor: cursor ?? null,
        includeInactive: all && isMember,
      });
      return {
        items: page.items.map((p) => toProductResponse(p, app.gateways.r2.publicUrl)),
        nextCursor: page.nextCursor,
      };
    },
  );
};
