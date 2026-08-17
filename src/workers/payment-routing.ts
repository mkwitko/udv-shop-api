import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import { createDonationsRepository } from "../http/api/donations/donations.repository.js";
import { createOrdersRepository } from "../http/api/orders/orders.repository.js";

/**
 * A partir do plano 5 um Payment pode pertencer a um Order OU a uma Donation. Chamar
 * `orders.markPaid` num pagamento de doação seria um bug de dinheiro: ele reivindica o
 * pagamento como "succeeded" e só depois descobre que não há orderId, deixando o
 * pagamento pago e a doação pendente para sempre. Por isso o agregado é decidido ANTES
 * de qualquer reivindicação — ver D1.
 */
async function aggregateOf(
  db: PrismaClient,
  paymentId: string,
): Promise<"order" | "donation" | null> {
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    select: { orderId: true, donationId: true },
  });
  if (!payment) return null;
  if (payment.orderId) return "order";
  if (payment.donationId) return "donation";
  return null;
}

export async function markPaymentPaid(deps: {
  db: PrismaClient;
  log: FastifyBaseLogger;
  paymentId: string;
  providerId: string | null;
}): Promise<void> {
  const kind = await aggregateOf(deps.db, deps.paymentId);
  if (kind === "order") {
    const result = await createOrdersRepository(deps.db).markPaid(deps.paymentId, deps.providerId);
    if (result && !result.orderWasPending) {
      deps.log.error({ orderId: result.orderId }, "pagamento recebido para pedido não pendente");
    }
    return;
  }
  if (kind === "donation") {
    const result = await createDonationsRepository(deps.db).markPaid(
      deps.paymentId,
      deps.providerId,
    );
    if (result && !result.donationWasPending) {
      deps.log.error(
        { donationId: result.donationId },
        "pagamento recebido para doação não pendente",
      );
    }
  }
}

/** Cancela o agregado pendente do pagamento (expiração/cancelamento no provedor). */
export async function cancelPaymentAggregate(deps: {
  db: PrismaClient;
  paymentId: string;
  reason: "expired" | "failed" | "cancelled";
}): Promise<void> {
  const payment = await deps.db.payment.findUnique({
    where: { id: deps.paymentId },
    select: { orderId: true, donationId: true },
  });
  if (payment?.orderId) {
    await createOrdersRepository(deps.db).cancelPendingOrder(payment.orderId, deps.reason);
    return;
  }
  if (payment?.donationId) {
    await createDonationsRepository(deps.db).cancelPendingDonation(payment.donationId, deps.reason);
  }
}

export async function refundPaymentByPaymentId(deps: {
  db: PrismaClient;
  paymentId: string;
}): Promise<void> {
  const kind = await aggregateOf(deps.db, deps.paymentId);
  if (kind === "order") {
    await createOrdersRepository(deps.db).markRefundedByPaymentId(deps.paymentId);
    return;
  }
  if (kind === "donation") {
    await createDonationsRepository(deps.db).markRefundedByPaymentId(deps.paymentId);
  }
}

/**
 * Recebe candidatos porque `providerId` não é sempre o payment_intent: cobrança única
 * guarda o intent, mas ciclo de assinatura guarda o id do invoice. Procurar só pelo
 * intent fazia todo reembolso de doação mensal virar no-op silencioso.
 */
export async function refundPaymentByProviderId(deps: {
  db: PrismaClient;
  providerIds: string[];
}): Promise<void> {
  const providerIds = deps.providerIds.filter((id) => id.length > 0);
  if (providerIds.length === 0) return;
  const payment = await deps.db.payment.findFirst({
    where: { providerId: { in: providerIds } },
    select: { id: true },
  });
  if (!payment) return;
  await refundPaymentByPaymentId({ db: deps.db, paymentId: payment.id });
}
