import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { createProductsRepository } from "../../products/products.repository.js";
import { createInterestsRepository, toInterestResponse } from "../interests.repository.js";
import { InterestsPageResponse, StoreInterestsQuery } from "../interests.schema.js";
import { resolveStoreForRole } from "../manage.helpers.js";

export const listStoreInterestsRoute: FastifyPluginAsync = async (app) => {
  const repo = createInterestsRepository(db);
  const products = createProductsRepository(db);
  app.get(
    "/stores/:slug/interests",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "listStoreInterests",
        tags: ["interests"],
        params: z.object({ slug: z.string() }),
        querystring: StoreInterestsQuery,
        response: { 200: InterestsPageResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "staff");
      const { limit, cursor, status, productSlug } = req.query as z.infer<
        typeof StoreInterestsQuery
      >;
      let productId: string | null = null;
      if (productSlug !== undefined) {
        const product = await products.findBySlug(store.id, productSlug);
        if (!product) throw new NotFoundError("product_not_found");
        productId = product.id;
      }
      const page = await repo.listByStoreCursor({
        storeId: store.id,
        productId,
        status: status ?? null,
        limit,
        cursor: cursor ?? null,
      });
      return { items: page.items.map(toInterestResponse), nextCursor: page.nextCursor };
    },
  );
};
