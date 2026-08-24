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
      // "refund_pending" is allowed past this pre-check on purpose: it may be a stale claim
      // (crash/shutdown before the webhook confirmed it) that claimRefund below is entitled to
      // re-take. Rejecting it here unconditionally would make every retry 409 forever with no
      // way for an admin to re-drive it. A genuinely in-flight (non-stale) refund_pending is
      // still rejected — just by claimRefund's atomic check below, not by this pre-check.
      if (!payment || (payment.status !== "succeeded" && payment.status !== "refund_pending")) {
        throw new ConflictError("payment_not_refundable");
      }
      if (payment.provider === "stripe" && !payment.providerId) {
        throw new ConflictError("payment_not_refundable");
      }
      // Claim atomically before calling the gateway: the payment only flips to "refunded"
      // once the provider's webhook confirms it (seconds to minutes later), so without this
      // claim every retry in that window would hit the gateway again (duplicate money out).
      // claimRefund also re-claims a stale refund_pending; a fresh (non-stale) one fails the
      // claim and falls through to refund_already_requested below.
      const claimed = await repo.claimRefund(payment.id);
      if (!claimed) throw new ConflictError("refund_already_requested");
      try {
        if (payment.provider === "stripe") {
          // Reembolso antes do repasse ter saído: matar o evento pendente, senão o relay
          // repassa depois o dinheiro de um pedido que não existe mais (ADR-029).
          if (!payment.stripeTransferId) {
            await db.outboxEvent.updateMany({
              where: {
                type: "stripe.transfer",
                status: "pending",
                payload: { path: ["paymentId"], equals: payment.id },
              },
              data: { status: "processed" },
            });
          }
          // O que volta é o LÍQUIDO repassado, não o bruto: a taxa do provedor é da loja e
          // não é devolvida pelo Stripe. `providerFeeCents` nulo é pagamento do modelo
          // antigo, em que a plataforma pagou a taxa — aí o líquido é o bruto mesmo.
          const netCents = payment.amountCents - (payment.providerFeeCents ?? 0);
          // Same deterministic key pattern as the Woovi branch below: a fresh key per retry
          // would make every retry a distinct refund.
          const { reversalFailed } = await app.gateways.stripe.refundPaymentIntent({
            providerId: payment.providerId as string,
            transferId: payment.stripeTransferId,
            netCents,
            idempotencyKey: `refund-${payment.id}`,
          });
          if (reversalFailed) {
            // Dinheiro que a loja recebeu e não voltou. Registrado alto porque o acerto é
            // humano: o comprador já foi reembolsado pelo saldo da plataforma.
            req.log.error(
              { paymentId: payment.id, orderId: id, netCents },
              "reversal do repasse falhou: loja deve o líquido do pedido reembolsado",
            );
          }
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
