import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireStoreRole, requireWritableStore } from "../../../hooks/store-role.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { assertPayoutForStore } from "../product-payout.js";
import { createProductsRepository, toProductResponse } from "../products.repository.js";
import { ProductResponse, UpdateProductBody } from "../products.schema.js";

const Params = z.object({ slug: z.string(), productSlug: z.string() });

export const updateProductRoute: FastifyPluginAsync = async (app) => {
  app.patch(
    "/stores/:slug/products/:productSlug",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "updateProduct",
        tags: ["products"],
        params: Params,
        body: UpdateProductBody,
        response: { 200: ProductResponse },
      },
    },
    async (req) => {
      const { slug, productSlug } = req.params as z.infer<typeof Params>;
      const store = await createStoresRepository(db).findBySlug(slug);
      if (!store) throw new NotFoundError("store not found");
      requireStoreRole(req, store.id, "staff");
      requireWritableStore(req, store);
      const repo = createProductsRepository(db);
      const product = await repo.findBySlug(store.id, productSlug);
      if (!product) throw new NotFoundError("product not found");
      const body = req.body as UpdateProductBody;
      await assertPayoutForStore(store, {
        priceCents: body.priceCents ?? product.priceCents,
        supplierId: body.supplierId !== undefined ? body.supplierId : product.supplierId,
        payoutKind: body.payoutKind !== undefined ? body.payoutKind : product.payoutKind,
        payoutValue: body.payoutValue !== undefined ? body.payoutValue : product.payoutValue,
      });
      const updated = await repo.update(product.id, body);
      return toProductResponse(updated, app.gateways.r2.publicUrl, { payout: true });
    },
  );
};
