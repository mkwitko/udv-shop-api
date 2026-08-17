import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireUser } from "../../../hooks/auth.js";
import { createOrdersRepository, toOrderResponse } from "../orders.repository.js";
import { OrderResponse } from "../orders.schema.js";

export const getMyOrderRoute: FastifyPluginAsync = async (app) => {
  const repo = createOrdersRepository(db);
  app.get(
    "/orders/:id",
    {
      config: { permissions: { any: ["customer"] } },
      schema: {
        operationId: "getMyOrder",
        tags: ["orders"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: OrderResponse },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const { id } = req.params as { id: string };
      const order = await repo.findByIdForUser(id, user.sub);
      if (!order) throw new NotFoundError("order_not_found");
      return toOrderResponse(order);
    },
  );
};
