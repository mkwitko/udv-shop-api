import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireStoreRole, requireWritableStore } from "../../../hooks/store-role.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { createProductsRepository, toProductResponse } from "../products.repository.js";
import { ProductResponse } from "../products.schema.js";

const Params = z.object({ slug: z.string(), productSlug: z.string() });

/**
 * Espelho do arquivamento: o produto volta para a vitrine com o histórico intacto.
 * Idempotente — restaurar um produto ativo devolve ele mesmo.
 */
export const restoreProductRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/stores/:slug/products/:productSlug/restore",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "restoreProduct",
        tags: ["products"],
        params: Params,
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
      if (!product.active) await repo.restore(product.id);
      return toProductResponse({ ...product, active: true }, app.gateways.r2.publicUrl);
    },
  );
};
