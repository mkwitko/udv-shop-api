import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { createProductsRepository } from "../../products/products.repository.js";
import { createInterestsRepository } from "../interests.repository.js";
import { NotifyInterestsResponse } from "../interests.schema.js";
import { resolveStoreForRole } from "../manage.helpers.js";

export const notifyInterestsRoute: FastifyPluginAsync = async (app) => {
  const repo = createInterestsRepository(db);
  const products = createProductsRepository(db);
  app.post(
    "/stores/:slug/products/:productSlug/interests/notify",
    {
      // Avisar chegada dispara email para clientes: exige admin+, não staff.
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "notifyInterests",
        tags: ["interests"],
        params: z.object({ slug: z.string(), productSlug: z.string() }),
        response: { 200: NotifyInterestsResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "admin");
      requireWritableStore(req, store);
      const { productSlug } = req.params as { productSlug: string };
      const product = await products.findBySlug(store.id, productSlug);
      if (!product) throw new NotFoundError("product_not_found");
      const notified = await repo.notifyArrival(product.id);
      return { notified };
    },
  );
};
