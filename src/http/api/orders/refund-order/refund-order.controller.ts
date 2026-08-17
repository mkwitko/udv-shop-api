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
      if (payment.provider === "stripe" && !payment.providerId) {
        throw new ConflictError("payment_not_refundable");
      }
      // Claim atomically before calling the gateway: the payment only flips to "refunded"
      // once the provider's webhook confirms it (seconds to minutes later), so without this
      // claim every retry in that window would hit the gateway again (duplicate money out).
      const claimed = await repo.claimRefund(payment.id);
      if (!claimed) throw new ConflictError("refund_already_requested");
      try {
        if (payment.provider === "stripe") {
          await app.gateways.stripe.refundPaymentIntent(payment.providerId as string);
        } else {
          await app.gateways.woovi.refundCharge({
            chargeCorrelationID: payment.id,
            // Deterministic: this is Woovi's idempotency key, a fresh UUID per request
            // would make every retry a distinct refund.
            refundCorrelationID: `refund-${payment.id}`,
          });
        }
      } catch (err) {
        await repo.releaseRefundClaim(payment.id);
        throw err;
      }
      void reply.code(202).send({ status: "refund_requested" });
    },
  );
};
