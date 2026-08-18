import type { FastifyPluginAsync } from "fastify";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError, ValidationError } from "../../../../shared/errors.js";
import { requireUser } from "../../../hooks/auth.js";
import { createProductsRepository } from "../../products/products.repository.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { createInterestsRepository, toInterestResponse } from "../interests.repository.js";
import { CreateInterestBody, InterestResponse } from "../interests.schema.js";

export const createInterestRoute: FastifyPluginAsync = async (app) => {
  const interests = createInterestsRepository(db);
  const stores = createStoresRepository(db);
  const products = createProductsRepository(db);
  app.post(
    "/interests",
    {
      config: { permissions: { any: ["customer"] } },
      schema: {
        operationId: "createInterest",
        tags: ["interests"],
        body: CreateInterestBody,
        response: { 201: InterestResponse },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const { storeSlug, productSlug, qty, note } = req.body as CreateInterestBody;
      const store = await stores.findBySlug(storeSlug);
      if (store?.status !== "active") throw new NotFoundError("store_not_found");
      const product = await products.findBySlug(store.id, productSlug);
      if (!product?.active) throw new NotFoundError("product_not_found");
      // Sob encomenda sempre aceita; produto de estoque só quando esgotou — é o
      // "me avise quando chegar" da página do produto, não uma fila paralela à venda.
      if (product.availability !== "on_demand" && product.stock > 0) {
        throw new ValidationError("product_available");
      }
      const interest = await interests.upsertOpen({
        productId: product.id,
        userId: user.sub,
        qty,
        note: note ?? null,
      });
      void reply.code(201).send(toInterestResponse(interest));
    },
  );
};
