import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { createOrdersRepository } from "../http/api/orders/orders.repository.js";

const WOOVI_COMPLETED = "OPENPIX:CHARGE_COMPLETED";
const WOOVI_EXPIRED = "OPENPIX:CHARGE_EXPIRED";
const WOOVI_REFUNDED = "OPENPIX:CHARGE_REFUND";

const uuidSchema = z.string().uuid();

type StripePayload = {
  data?: { object?: { id?: string; payment_intent?: string; metadata?: Record<string, string> } };
};
type WooviPayload = { charge?: { correlationID?: string } };

/**
 * Processes webhook events with status "received". Pass `eventId` to process only that
 * single row (used by the webhook controllers right after they persist it, so a busy
 * provider request never blocks on draining the whole backlog); omit it to drain up to 50
 * rows (used by the 15s recovery worker).
 */
export async function processWebhookEvents(deps: {
  db: PrismaClient;
  log: FastifyBaseLogger;
  eventId?: string;
}): Promise<number> {
  const orders = createOrdersRepository(deps.db);
  const events = await deps.db.webhookEvent.findMany({
    where: deps.eventId ? { id: deps.eventId, status: "received" } : { status: "received" },
    orderBy: { createdAt: "asc" },
    take: deps.eventId ? 1 : 50,
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
        } else if (event.type === "payment_intent.canceled" && object.metadata?.orderId) {
          // Only "canceled" is terminal. "payment_intent.payment_failed" fires on every
          // declined attempt and the same intent can be retried and later succeed — the
          // 30-min expiry worker is the single owner of reservation release (see I1 in the
          // final review / ADR-012 update).
          await orders.cancelPendingOrder(object.metadata.orderId, "failed");
        } else if (event.type === "payment_intent.payment_failed") {
          deps.log.warn(
            { paymentId, orderId: object.metadata?.orderId },
            "tentativa de pagamento falhou; intent ainda pode ser retentada, pedido segue pending_payment",
          );
        } else if (event.type === "charge.refunded" && object.payment_intent) {
          await orders.markRefundedByProviderId(object.payment_intent);
        }
      } else {
        const payload = event.payload as WooviPayload;
        const rawCorrelationID = payload.charge?.correlationID;
        // Woovi's correlationID is our payment.id (@db.Uuid). A provider test/ping webhook
        // can carry a non-UUID value; feeding that straight into Prisma throws P2023, which
        // used to mark the event terminally "failed". Treat a non-match as ignored instead.
        const paymentId =
          rawCorrelationID && uuidSchema.safeParse(rawCorrelationID).success
            ? rawCorrelationID
            : null;
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
