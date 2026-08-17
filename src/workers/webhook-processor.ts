import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import { createOrdersRepository } from "../http/api/orders/orders.repository.js";

const WOOVI_COMPLETED = "OPENPIX:CHARGE_COMPLETED";
const WOOVI_EXPIRED = "OPENPIX:CHARGE_EXPIRED";
const WOOVI_REFUNDED = "OPENPIX:CHARGE_REFUND";

type StripePayload = {
  data?: { object?: { id?: string; payment_intent?: string; metadata?: Record<string, string> } };
};
type WooviPayload = { charge?: { correlationID?: string } };

export async function processWebhookEvents(deps: {
  db: PrismaClient;
  log: FastifyBaseLogger;
}): Promise<number> {
  const orders = createOrdersRepository(deps.db);
  const events = await deps.db.webhookEvent.findMany({
    where: { status: "received" },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  let processed = 0;
  for (const event of events) {
    try {
      if (event.provider === "stripe") {
        const payload = event.payload as StripePayload;
        const object = payload.data?.object ?? {};
        const paymentId = object.metadata?.paymentId;
        if (event.type === "payment_intent.succeeded" && paymentId) {
          const result = await orders.markPaid(paymentId, object.id ?? null);
          if (result && !result.orderWasPending) {
            deps.log.error(
              { orderId: result.orderId },
              "pagamento recebido para pedido não pendente",
            );
          }
        } else if (
          (event.type === "payment_intent.payment_failed" ||
            event.type === "payment_intent.canceled") &&
          object.metadata?.orderId
        ) {
          await orders.cancelPendingOrder(object.metadata.orderId, "failed");
        } else if (event.type === "charge.refunded" && object.payment_intent) {
          await orders.markRefundedByProviderId(object.payment_intent);
        }
      } else {
        const payload = event.payload as WooviPayload;
        const paymentId = payload.charge?.correlationID;
        if (paymentId) {
          if (event.type === WOOVI_COMPLETED) {
            const result = await orders.markPaid(paymentId, null);
            if (result && !result.orderWasPending) {
              deps.log.error(
                { orderId: result.orderId },
                "pagamento recebido para pedido não pendente",
              );
            }
          } else if (event.type === WOOVI_EXPIRED) {
            const payment = await deps.db.payment.findUnique({ where: { id: paymentId } });
            if (payment?.orderId) await orders.cancelPendingOrder(payment.orderId, "expired");
          } else if (event.type === WOOVI_REFUNDED) {
            await orders.markRefundedByPaymentId(paymentId);
          }
        }
      }
      await deps.db.webhookEvent.update({
        where: { id: event.id },
        data: { status: "processed", processedAt: new Date() },
      });
      processed++;
    } catch (err) {
      deps.log.error({ err, webhookEventId: event.id }, "falha ao processar webhook");
      await deps.db.webhookEvent.update({
        where: { id: event.id },
        data: { status: "failed", error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return processed;
}
