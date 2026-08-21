import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { optionalUser } from "../../../hooks/optional-user.js";
import { createProductCategoriesRepository } from "../../product-categories/product-categories.repository.js";
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
      const { limit, cursor, all, category, q, sort } = req.query as ListProductsQuery;

      // slug de categoria vira id aqui: o cliente nunca escolhe id, e categoria que não
      // existe mais (link antigo no WhatsApp) devolve vitrine vazia em vez de erro
      let categoryId: string | undefined;
      if (category) {
        const found = await createProductCategoriesRepository(db).findBySlug(store.id, category);
        if (!found) return { items: [], nextCursor: null };
        categoryId = found.id;
      }

      const page = await createProductsRepository(db).listByStoreCursor({
        storeId: store.id,
        limit,
        cursor: cursor ?? null,
        includeInactive: all && isMember,
        categoryId,
        search: q,
        sort,
      });
      return {
        items: page.items.map((p) =>
          toProductResponse(p, app.gateways.r2.publicUrl, { payout: isMember }),
        ),
        nextCursor: page.nextCursor,
      };
    },
  );
};
