import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ConflictError, NotFoundError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveStoreForRole } from "../manage.helpers.js";
import { createOrdersRepository, toOrderResponse } from "../orders.repository.js";
import { OrderResponse } from "../orders.schema.js";

export const cancelOrderRoute: FastifyPluginAsync = async (app) => {
  const repo = createOrdersRepository(db);
  app.post(
    "/stores/:slug/orders/:id/cancel",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "cancelOrder",
        tags: ["orders"],
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        response: { 200: OrderResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "admin");
      requireWritableStore(req, store);
      const { id } = req.params as { id: string };
      const order = await repo.findByIdForStore(id, store.id);
      if (!order) throw new NotFoundError("order_not_found");
      const ok = await repo.cancelPendingOrder(id, "cancelled");
      if (!ok) throw new ConflictError("invalid_status_transition");
      const fresh = await repo.findByIdForStore(id, store.id);
      if (!fresh) throw new NotFoundError("order_not_found");
      return toOrderResponse(fresh);
    },
  );
};
