import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { EmailGateway } from "../gateways/email/email.gateway.js";

const MAX_ATTEMPTS = 5;

export async function relayOutbox(deps: {
  db: PrismaClient;
  email: EmailGateway;
  log: FastifyBaseLogger;
}): Promise<number> {
  const events = await deps.db.outboxEvent.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    take: 50,
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
      }
      await deps.db.outboxEvent.update({
        where: { id: event.id },
        data: { status: "processed", processedAt: new Date() },
      });
      processed++;
    } catch (err) {
      deps.log.error({ err, outboxEventId: event.id }, "falha no outbox relay");
      const attempts = event.attempts + 1;
      await deps.db.outboxEvent.update({
        where: { id: event.id },
        data: { attempts, ...(attempts >= MAX_ATTEMPTS && { status: "failed" }) },
      });
    }
  }
  return processed;
}
