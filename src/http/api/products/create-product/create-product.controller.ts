import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireStoreRole } from "../../../hooks/store-role.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { createProductsRepository, toProductResponse } from "../products.repository.js";
import { CreateProductBody, ProductResponse } from "../products.schema.js";
import { createCreateProductService } from "./create-product.service.js";

const Params = z.object({ slug: z.string() });

export const createProductRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/stores/:slug/products",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "createProduct",
        tags: ["products"],
        params: Params,
        body: CreateProductBody,
        response: { 201: ProductResponse },
      },
    },
    async (req, reply) => {
      const store = await createStoresRepository(db).findBySlug(
        (req.params as z.infer<typeof Params>).slug,
      );
      if (!store) throw new NotFoundError("store not found");
      requireStoreRole(req, store.id, "staff");
      const service = createCreateProductService({ repo: createProductsRepository(db) });
      const product = await service({ ...(req.body as CreateProductBody), storeId: store.id });
      void reply.code(201).send(toProductResponse(product, app.gateways.r2.publicUrl));
    },
  );
};
