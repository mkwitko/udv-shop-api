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

/**
 * Grava a taxa que o provedor cobrou de fato nesta transação. Chamado com o mesmo valor em
 * cada reprocessamento do webhook — é idempotente por ser escrita de valor, não incremento.
 */
export async function recordProviderFee(deps: {
  db: PrismaClient;
  paymentId: string;
  providerFeeCents: number;
}): Promise<void> {
  await deps.db.payment.updateMany({
    where: { id: deps.paymentId },
    data: { providerFeeCents: deps.providerFeeCents },
  });
}

/**
 * Enfileira o repasse do líquido para a conta conectada da loja. Só faz sentido em separate
 * charges and transfers (ADR-029): em destination charge o dinheiro já saía na própria
 * cobrança. O evento carrega o charge porque é dele que sai a taxa real e é ele que financia
 * o transfer.
 *
 * Vai pelo outbox e não direto, pelo mesmo motivo do saque Woovi: o Stripe pode estar fora
 * do ar no instante do webhook, e perder o repasse é perder dinheiro de outra pessoa.
 */
export async function enqueueStripeTransfer(deps: {
  db: PrismaClient;
  paymentId: string;
  chargeId: string;
}): Promise<void> {
  await deps.db.outboxEvent.create({
    data: {
      type: "stripe.transfer",
      payload: { paymentId: deps.paymentId, chargeId: deps.chargeId },
    },
  });
}

/**
 * Repasse do ciclo de uma doação mensal. Diferente do pagamento único, aqui não temos o
 * charge: a fatura é que o conhece, e achá-lo custa uma chamada ao Stripe — que o relay faz,
 * não este worker.
 */
export async function enqueueStripeTransferForInvoice(deps: {
  db: PrismaClient;
  invoiceId: string;
}): Promise<void> {
  // O Payment do ciclo guarda o id da FATURA em providerId (ver markSubscriptionInvoicePaid).
  const payment = await deps.db.payment.findFirst({
    where: { providerId: deps.invoiceId },
    select: { id: true },
  });
  if (!payment) return;
  await deps.db.outboxEvent.create({
    data: {
      type: "stripe.transfer",
      payload: { paymentId: payment.id, invoiceId: deps.invoiceId },
    },
  });
}

/**
 * Enfileira o saque da subconta Woovi da loja. Split para subconta é VIRTUAL: o valor
 * fica reservado dentro da conta da plataforma e só sai no saque, então sem esta chamada
 * o dinheiro do núcleo nunca chega na conta dele.
 *
 * Vai pelo outbox e não direto: a Woovi pode estar fora do ar no instante do webhook, e
 * perder o saque é perder dinheiro de outra pessoa. O saque leva TODO o saldo, então
 * reprocessar é inofensivo — no pior caso encontra a subconta zerada.
 */
export async function enqueueWooviWithdraw(deps: {
  db: PrismaClient;
  paymentId: string;
}): Promise<void> {
  const payment = await deps.db.payment.findUnique({
    where: { id: deps.paymentId },
    select: {
      order: { select: { store: { select: { id: true, wooviPixKey: true } } } },
      donation: { select: { store: { select: { id: true, wooviPixKey: true } } } },
    },
  });
  const store = payment?.order?.store ?? payment?.donation?.store;
  if (!store?.wooviPixKey) return;
  await deps.db.outboxEvent.create({
    data: {
      type: "woovi.withdraw",
      payload: { storeId: store.id, pixKey: store.wooviPixKey, paymentId: deps.paymentId },
    },
  });
}
