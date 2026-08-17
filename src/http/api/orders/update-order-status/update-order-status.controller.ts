import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ConflictError, NotFoundError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveStoreForRole } from "../manage.helpers.js";
import { createOrdersRepository, toOrderResponse } from "../orders.repository.js";
import { OrderResponse, UpdateOrderStatusBody } from "../orders.schema.js";

const VALID_FROM = {
  delivery_arranged: ["paid"],
  delivered: ["paid", "delivery_arranged"],
} as const;

export const updateOrderStatusRoute: FastifyPluginAsync = async (app) => {
  const repo = createOrdersRepository(db);
  app.patch(
    "/stores/:slug/orders/:id/status",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "updateOrderStatus",
        tags: ["orders"],
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        body: UpdateOrderStatusBody,
        response: { 200: OrderResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "staff");
      requireWritableStore(req, store);
      const { id } = req.params as { id: string };
      const { status } = req.body as z.infer<typeof UpdateOrderStatusBody>;
      const order = await repo.findByIdForStore(id, store.id);
      if (!order) throw new NotFoundError("order_not_found");
      const ok = await repo.updateOrderStatus(id, [...VALID_FROM[status]], status);
      if (!ok) throw new ConflictError("invalid_status_transition");
      const fresh = await repo.findByIdForStore(id, store.id);
      if (!fresh) throw new NotFoundError("order_not_found");
      return toOrderResponse(fresh);
    },
  );
};
