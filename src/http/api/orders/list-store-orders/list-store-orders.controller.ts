import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { resolveStoreForRole } from "../manage.helpers.js";
import { createOrdersRepository, toOrderResponse } from "../orders.repository.js";
import { OrdersPageResponse, StoreOrdersQuery } from "../orders.schema.js";

export const listStoreOrdersRoute: FastifyPluginAsync = async (app) => {
  const repo = createOrdersRepository(db);
  app.get(
    "/stores/:slug/orders",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "listStoreOrders",
        tags: ["orders"],
        params: z.object({ slug: z.string() }),
        querystring: StoreOrdersQuery,
        response: { 200: OrdersPageResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "staff");
      const { limit, cursor, status } = req.query as z.infer<typeof StoreOrdersQuery>;
      const page = await repo.listByStoreCursor({
        storeId: store.id,
        status: status ?? null,
        limit,
        cursor: cursor ?? null,
      });
      return { items: page.items.map(toOrderResponse), nextCursor: page.nextCursor };
    },
  );
};
