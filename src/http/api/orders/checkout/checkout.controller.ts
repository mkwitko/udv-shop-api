import type { FastifyPluginAsync } from "fastify";
import { db } from "../../../../infra/db/client.js";
import { requireUser } from "../../../hooks/auth.js";
import { createProductsRepository } from "../../products/products.repository.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { createOrdersRepository, toOrderResponse } from "../orders.repository.js";
import { CheckoutBody, CheckoutResponse } from "../orders.schema.js";
import { createCheckoutService } from "./checkout.service.js";

export const checkoutRoute: FastifyPluginAsync = async (app) => {
  const service = createCheckoutService({
    orders: createOrdersRepository(db),
    stores: createStoresRepository(db),
    products: createProductsRepository(db),
    stripe: app.gateways.stripe,
    woovi: app.gateways.woovi,
  });
  app.post(
    "/orders",
    {
      config: { permissions: { any: ["customer"] } },
      schema: {
        operationId: "checkout",
        tags: ["orders"],
        body: CheckoutBody,
        response: { 201: CheckoutResponse },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const body = req.body as CheckoutBody;
      const result = await service({ ...body, userId: user.sub });
      void reply.code(201).send({ order: toOrderResponse(result.order), payment: result.payment });
    },
  );
};
