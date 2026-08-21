import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireUser } from "../../../hooks/auth.js";
import { createProductsRepository } from "../../products/products.repository.js";
import { createInterestsRepository, toStoreInterestResponse } from "../interests.repository.js";
import { StoreInterestsPageResponse, StoreInterestsQuery } from "../interests.schema.js";
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
        response: { 200: StoreInterestsPageResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "staff");
      const user = requireUser(req);
      const role = user.roles[store.id];
      // Quem responde pela loja vê o número inteiro para poder avisar por WhatsApp; staff
      // segue no mascarado. É a mesma fronteira do botão que dispara o aviso de chegada.
      const revealPhone = user.platformAdmin || role === "owner" || role === "admin";
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
      return {
        items: page.items.map((item) => toStoreInterestResponse(item, revealPhone)),
        nextCursor: page.nextCursor,
      };
    },
  );
};
