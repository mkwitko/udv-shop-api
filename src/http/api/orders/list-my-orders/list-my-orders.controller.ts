import type { FastifyPluginAsync } from "fastify";
import type { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { requireUser } from "../../../hooks/auth.js";
import { createOrdersRepository, toOrderResponse } from "../orders.repository.js";
import { OrdersListQuery, OrdersPageResponse } from "../orders.schema.js";

export const listMyOrdersRoute: FastifyPluginAsync = async (app) => {
  const repo = createOrdersRepository(db);
  app.get(
    "/orders",
    {
      config: { permissions: { any: ["customer"] } },
      schema: {
        operationId: "listMyOrders",
        tags: ["orders"],
        querystring: OrdersListQuery,
        response: { 200: OrdersPageResponse },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const { limit, cursor } = req.query as z.infer<typeof OrdersListQuery>;
      const page = await repo.listMineCursor({ userId: user.sub, limit, cursor: cursor ?? null });
      return { items: page.items.map(toOrderResponse), nextCursor: page.nextCursor };
    },
  );
};
