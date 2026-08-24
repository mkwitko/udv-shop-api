import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { createDonationsRepository } from "../http/api/donations/donations.repository.js";
import {
  applyAccountUpdated,
  applyCheckoutCompleted,
  applySubscriptionEvent,
} from "./billing-webhook.js";
import {
  cancelPaymentAggregate,
  enqueueWooviWithdraw,
  markPaymentPaid,
  refundPaymentByPaymentId,
  refundPaymentByProviderId,
} from "./payment-routing.js";
import { settleWooviPixKeyVerification } from "./pix-key-verification.js";

const WOOVI_COMPLETED = "OPENPIX:CHARGE_COMPLETED";
const WOOVI_EXPIRED = "OPENPIX:CHARGE_EXPIRED";
/**
 * O evento de estorno da Woovi é `OPENPIX:TRANSACTION_REFUND_RECEIVED` (evento de
 * transação, não de cobrança). `OPENPIX:CHARGE_REFUND`, que estava aqui antes, não existe
 * no catálogo deles: o webhook de reembolso chegava, era gravado, marcado como processado
 * e o pagamento seguia "succeeded" para sempre. O nome antigo fica aceito porque não custa
 * nada e evita quebrar quem já tenha um webhook configurado assim.
 */
const WOOVI_REFUNDED = ["OPENPIX:TRANSACTION_REFUND_RECEIVED", "OPENPIX:CHARGE_REFUND"];

const uuidSchema = z.string().uuid();

/** União dos campos que este arquivo lê dos objetos que o Stripe entrega neste endpoint. */
type StripeObject = {
  id?: string;
  payment_intent?: string;
  invoice?: string;
  subscription?: string;
  amount_paid?: number;
  parent?: { subscription_details?: { subscription?: string | { id?: string } } } | null;
  metadata?: Record<string, string>;
  // checkout.session
  mode?: string;
  client_reference_id?: string | null;
  // customer.subscription.*
  customer?: string | { id?: string };
  status?: string;
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  items?: { data?: Array<{ current_period_end?: number; price?: { id?: string } }> };
  // account.updated
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
};
type StripePayload = {
  // Só eventos nascidos numa conta conectada trazem `account` — hoje isso é o onboarding
  // (account.updated). Assinaturas, tanto de doação quanto SaaS, nascem na plataforma e
  // são separadas pelo lookup de subscriptionRef, não por este campo — ver ADR-021/025.
  account?: string;
  data?: { object?: StripeObject };
};
type WooviPayload = {
  charge?: { correlationID?: string };
  /** `pix.payer` é quem pagou de verdade — é o que prova posse da chave na verificação. */
  pix?: { payer?: { name?: string; taxID?: { taxID?: string } } };
};

/**
 * A partir de Basil (a API fixada aqui é 2026-07-29.dahlia) o id da assinatura saiu do topo
 * do Invoice e vive em `parent.subscription_details.subscription`, que pode chegar expandido.
 * Ler o antigo `invoice.subscription` devolvia sempre undefined: o invoice.paid era marcado
 * "processed" sem criar a doação, e a assinatura seguia cobrando fora do banco. O campo plano
 * continua sendo lido como fallback para endpoints ainda fixados numa versão pré-Basil.
 */
function subscriptionRefOf(object: StripeObject): string | null {
  const sub = object.parent?.subscription_details?.subscription;
  if (typeof sub === "string") return sub;
  if (sub && typeof sub.id === "string") return sub.id;
  return typeof object.subscription === "string" ? object.subscription : null;
}

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
        // Evento da conta conectada (assinatura de doação, onboarding) × evento da
        // plataforma (assinatura SaaS). Sem esta separação, o cancelamento de uma
        // assinatura SaaS cairia no ramo de doação e vice-versa.
        const fromConnectedAccount = typeof payload.account === "string";
        const paymentId = object.metadata?.paymentId;
        const subscriptionRef = subscriptionRefOf(object);
        // Desde que a doação mensal virou destination charge (ADR-025), assinatura de
        // doação e assinatura SaaS da loja nascem as duas na conta da plataforma e
        // compartilham os mesmos tipos de evento. `payload.account` não separa mais nada
        // aqui: quem separa é saber se aquele subscriptionRef é de uma doação. Sem isso,
        // um cancelamento de doação derrubaria a assinatura da loja.
        const subscriptionId =
          subscriptionRef ??
          (event.type.startsWith("customer.subscription.") && typeof object.id === "string"
            ? object.id
            : null);
        const isDonationSubscription =
          subscriptionId !== null &&
          (await createDonationsRepository(deps.db).isDonationSubscription(subscriptionId));
        const invoice =
          typeof object.id === "string" &&
          subscriptionRef !== null &&
          typeof object.amount_paid === "number"
            ? { id: object.id, subscription: subscriptionRef, amount_paid: object.amount_paid }
            : null;
        if (event.type === "payment_intent.succeeded" && paymentId) {
          await markPaymentPaid({
            db: deps.db,
            log: deps.log,
            paymentId,
            providerId: object.id ?? null,
          });
        } else if (event.type === "payment_intent.canceled" && paymentId) {
          // Só "canceled" é terminal. "payment_intent.payment_failed" dispara em toda
          // tentativa recusada e a mesma intent pode ser retentada e depois aprovada —
          // o worker de expiração é o dono único da liberação (ADR-012).
          await cancelPaymentAggregate({ db: deps.db, paymentId, reason: "failed" });
        } else if (event.type === "payment_intent.payment_failed") {
          deps.log.warn(
            { paymentId, orderId: object.metadata?.orderId },
            "tentativa de pagamento falhou; intent ainda pode ser retentada, agregado segue pendente",
          );
        } else if (event.type === "charge.refunded") {
          // Cobrança única guarda o payment_intent em providerId; ciclo de assinatura
          // guarda o id do invoice. O charge carrega os dois campos, então tentamos ambos.
          await refundPaymentByProviderId({
            db: deps.db,
            providerIds: [object.payment_intent, object.invoice].filter(
              (id): id is string => typeof id === "string",
            ),
          });
        } else if (
          event.type === "invoice.paid" &&
          invoice?.subscription &&
          isDonationSubscription
        ) {
          await createDonationsRepository(deps.db).markSubscriptionInvoicePaid({
            subscriptionRef: invoice.subscription,
            invoiceId: invoice.id,
            amountCents: invoice.amount_paid,
          });
        } else if (
          event.type === "customer.subscription.deleted" &&
          object.id &&
          isDonationSubscription
        ) {
          await createDonationsRepository(deps.db).markSubscriptionCancelled(object.id);
        } else if (event.type === "account.updated") {
          const matched = await applyAccountUpdated(deps.db, object);
          if (matched === 0) {
            deps.log.warn(
              { stripeAccountId: object.id },
              "account.updated de conta conectada sem loja correspondente",
            );
          }
        } else if (event.type === "checkout.session.completed" && !fromConnectedAccount) {
          await applyCheckoutCompleted(deps.db, object);
        } else if (
          !fromConnectedAccount &&
          !isDonationSubscription &&
          (event.type === "customer.subscription.created" ||
            event.type === "customer.subscription.updated" ||
            event.type === "customer.subscription.deleted")
        ) {
          await applySubscriptionEvent(deps.db, object, event.type);
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
            // A cobrança da prova de posse usa o id da verificação como correlationID.
            // Ela vem antes porque não é pagamento de pedido nenhum: seguir para
            // markPaymentPaid faria o centavo procurar um Payment que não existe.
            const verificacao = await settleWooviPixKeyVerification({
              db: deps.db,
              log: deps.log,
              verificationId: paymentId,
              payer: {
                name: payload.pix?.payer?.name ?? null,
                taxId: payload.pix?.payer?.taxID?.taxID ?? null,
              },
            });
            if (!verificacao) {
              await markPaymentPaid({ db: deps.db, log: deps.log, paymentId, providerId: null });
              // O split já creditou a subconta, mas subconta é saldo virtual dentro da conta
              // da plataforma: sem o saque o dinheiro do núcleo não sai daqui.
              await enqueueWooviWithdraw({ db: deps.db, paymentId });
            }
          } else if (event.type === WOOVI_EXPIRED) {
            await cancelPaymentAggregate({ db: deps.db, paymentId, reason: "expired" });
          } else if (WOOVI_REFUNDED.includes(event.type)) {
            await refundPaymentByPaymentId({ db: deps.db, paymentId });
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
