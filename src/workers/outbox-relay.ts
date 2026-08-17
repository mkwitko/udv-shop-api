import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { EmailGateway } from "../gateways/email/email.gateway.js";

const MAX_ATTEMPTS = 5;
// A row claimed into "processing" that never reaches "processed"/"failed" (crash, shutdown,
// or any throw between the claim and the per-row update) would otherwise be stuck forever —
// every query here only looks at "pending". Past this window we treat the claim as abandoned
// and give the row back.
const STALE_CLAIM_MS = 5 * 60_000;

export async function relayOutbox(deps: {
  db: PrismaClient;
  email: EmailGateway;
  log: FastifyBaseLogger;
}): Promise<number> {
  // Reap stale claims before doing anything else so an abandoned row is eligible for
  // (re-)claiming below in the same tick.
  await deps.db.outboxEvent.updateMany({
    where: { status: "processing", claimedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } },
    data: { status: "pending", claimedBy: null, claimedAt: null },
  });

  const candidates = await deps.db.outboxEvent.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: { id: true },
  });
  if (candidates.length === 0) return 0;
  const ids = candidates.map((c) => c.id);
  // Claim atomically before doing work, tagging the claim with a per-tick token: an
  // overlapping tick (slow tick past its interval, or a second app instance) re-reading
  // "pending" would otherwise re-send the same email. Tagging matters on a *partial* claim
  // too (createdAt ties can make two instances' 50-row windows differ) — without the token,
  // re-reading by `status: "processing"` alone would pick up rows the other instance just
  // claimed and re-send their emails, exactly the duplicate the claim was meant to prevent.
  // So we only ever process rows this tick itself claimed, whatever that turns out to be.
  const token = randomUUID();
  await deps.db.outboxEvent.updateMany({
    where: { id: { in: ids }, status: "pending" },
    data: { status: "processing", claimedBy: token, claimedAt: new Date() },
  });
  const events = await deps.db.outboxEvent.findMany({
    where: { id: { in: ids }, status: "processing", claimedBy: token },
    orderBy: { createdAt: "asc" },
  });
  let processed = 0;
  for (const event of events) {
    try {
      if (event.type === "order.paid") {
        const { orderId } = event.payload as { orderId: string };
        const order = await deps.db.order.findUnique({
          where: { id: orderId },
          include: { items: true, user: true, store: { select: { name: true } } },
        });
        if (order) {
          const lines = order.items
            .map((i) => `<li>${i.qty}× ${i.name} — R$ ${(i.priceCents / 100).toFixed(2)}</li>`)
            .join("");
          await deps.email.send({
            to: order.user.email,
            subject: `Pagamento confirmado — ${order.store.name}`,
            html: `<p>Olá, ${order.user.name}!</p><p>Recebemos o pagamento do seu pedido na loja ${order.store.name}. A equipe do núcleo vai entrar em contato pelo telefone informado para combinar a entrega.</p><ul>${lines}</ul><p>Total: R$ ${(order.totalCents / 100).toFixed(2)}</p><p>Obrigado por apoiar o núcleo!</p>`,
          });
        }
      } else if (event.type === "payment.orphaned") {
        // Money captured for an order that is no longer pending. No email — this is an
        // operator alert, not a customer-facing message. Durable + queryable via this row;
        // logging here just surfaces it in real time too.
        const { orderId, paymentId } = event.payload as { orderId: string; paymentId: string };
        deps.log.error(
          { orderId, paymentId },
          "pagamento órfão: pagamento capturado para pedido não pendente, reembolso manual necessário",
        );
      }
      await deps.db.outboxEvent.update({
        where: { id: event.id },
        data: { status: "processed", processedAt: new Date(), claimedBy: null, claimedAt: null },
      });
      processed++;
    } catch (err) {
      deps.log.error({ err, outboxEventId: event.id }, "falha no outbox relay");
      const attempts = event.attempts + 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      await deps.db.outboxEvent.update({
        where: { id: event.id },
        data: {
          attempts,
          status: terminal ? "failed" : "pending",
          claimedBy: terminal ? null : event.claimedBy,
          claimedAt: terminal ? null : event.claimedAt,
        },
      });
    }
  }
  return processed;
}
