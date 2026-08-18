import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { optionalUser } from "../../../hooks/optional-user.js";
import { assertStoreReadable, isStoreMember } from "../../stores/store-visibility.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { createProductsRepository, toProductResponse } from "../products.repository.js";
import { ProductResponse } from "../products.schema.js";

const Params = z.object({ slug: z.string(), productSlug: z.string() });

export const getProductRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/stores/:slug/products/:productSlug",
    {
      config: { public: true },
      schema: {
        operationId: "getProduct",
        tags: ["products"],
        params: Params,
        response: { 200: ProductResponse },
      },
    },
    async (req) => {
      const { slug, productSlug } = req.params as z.infer<typeof Params>;
      const store = await createStoresRepository(db).findBySlug(slug);
      const user = await optionalUser(req);
      assertStoreReadable(store, user);
      const isMember = isStoreMember(user, store.id);
      const product = await createProductsRepository(db).findBySlug(store.id, productSlug);
      if (!product || (!product.active && !isMember)) {
        throw new NotFoundError("product not found");
      }
      return toProductResponse(product, app.gateways.r2.publicUrl, { payout: isMember });
    },
  );
};
