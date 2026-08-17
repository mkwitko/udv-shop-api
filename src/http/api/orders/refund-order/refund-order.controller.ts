import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ConflictError, NotFoundError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveStoreForRole } from "../manage.helpers.js";
import { createOrdersRepository } from "../orders.repository.js";
import { RefundAcceptedResponse } from "../orders.schema.js";

export const refundOrderRoute: FastifyPluginAsync = async (app) => {
  const repo = createOrdersRepository(db);
  app.post(
    "/stores/:slug/orders/:id/refund",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "refundOrder",
        tags: ["orders"],
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        response: { 202: RefundAcceptedResponse },
      },
    },
    async (req, reply) => {
      const store = await resolveStoreForRole(req, "admin");
      requireWritableStore(req, store);
      const { id } = req.params as { id: string };
      const order = await repo.findByIdForStore(id, store.id);
      if (!order) throw new NotFoundError("order_not_found");
      const payment = await repo.findPaymentByOrderId(id);
      if (!payment || payment.status !== "succeeded") {
        throw new ConflictError("payment_not_refundable");
      }
      if (payment.provider === "stripe") {
        if (!payment.providerId) throw new ConflictError("payment_not_refundable");
        await app.gateways.stripe.refundPaymentIntent(payment.providerId);
      } else {
        await app.gateways.woovi.refundCharge({
          chargeCorrelationID: payment.id,
          refundCorrelationID: randomUUID(),
        });
      }
      void reply.code(202).send({ status: "refund_requested" });
    },
  );
};
