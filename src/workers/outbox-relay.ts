import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../config/env.js";
import type { EmailGateway } from "../gateways/email/email.gateway.js";
import type { WooviGateway } from "../gateways/woovi/woovi.gateway.js";
import { createInterestsRepository } from "../http/api/interests/interests.repository.js";
import { createRafflesRepository } from "../http/api/raffles/raffles.repository.js";
import { escapeHtml } from "../lib/html.js";

const MAX_ATTEMPTS = 5;

/**
 * Quem recebe os avisos de venda da loja: dono e administradores. Equipe fica fora — o
 * telefone do cliente e o valor da venda são dados de quem responde pelo negócio.
 */
async function storeInbox(db: PrismaClient, storeId: string): Promise<string[]> {
  const rows = await db.userStoreRole.findMany({
    where: { storeId, role: { in: ["owner", "admin"] } },
    select: { user: { select: { email: true } } },
  });
  return rows.map((row) => row.user.email).filter((email): email is string => Boolean(email));
}

// A row claimed into "processing" that never reaches "processed"/"failed" (crash, shutdown,
// or any throw between the claim and the per-row update) would otherwise be stuck forever —
// every query here only looks at "pending". Past this window we treat the claim as abandoned
// and give the row back.
const STALE_CLAIM_MS = 5 * 60_000;

export async function relayOutbox(deps: {
  db: PrismaClient;
  email: EmailGateway;
  woovi: WooviGateway;
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
          include: {
            items: true,
            user: { select: { email: true, name: true } },
            store: { select: { name: true } },
          },
        });
        if (order) {
          // Roda antes do email: é um updateMany guardado (idempotente), então uma
          // falha no envio nunca perde a conversão, e reprocessar o evento nunca
          // reenvia o email por causa dela.
          await createInterestsRepository(deps.db).convertForOrder({
            userId: order.userId,
            productIds: order.items.map((i) => i.productId),
          });
          const lines = order.items
            .map(
              (i) =>
                `<li>${i.qty}× ${escapeHtml(i.name)} — R$ ${(i.priceCents / 100).toFixed(2)}</li>`,
            )
            .join("");
          // Conta leve (compra sem conta) pode não ter e-mail: a loja combina a entrega pelo
          // telefone do pedido. O evento fecha de qualquer jeito — não há o que reenviar.
          if (!order.user.email) {
            deps.log.info({ orderId: order.id }, "order.paid sem e-mail: contato por telefone");
          } else {
            await deps.email.send({
              to: order.user.email,
              subject: `Pagamento confirmado — ${order.store.name}`,
              html: `<p>Olá, ${escapeHtml(order.user.name)}!</p><p>Recebemos o pagamento do seu pedido na loja ${escapeHtml(order.store.name)}. Quem cuida da loja vai entrar em contato pelo telefone informado para combinar a entrega.</p><ul>${lines}</ul><p>Total: R$ ${(order.totalCents / 100).toFixed(2)}</p><p>Obrigado por apoiar ${escapeHtml(order.store.name)}!</p>`,
            });
          }
        }
      } else if (event.type === "order.paid.store") {
        const { orderId } = event.payload as { orderId: string };
        const order = await deps.db.order.findUnique({
          where: { id: orderId },
          include: {
            items: true,
            user: { select: { name: true } },
            store: { select: { slug: true, name: true } },
          },
        });
        if (order) {
          const to = await storeInbox(deps.db, order.storeId);
          if (to.length === 0) {
            deps.log.warn({ orderId }, "pedido pago sem ninguém com e-mail na loja para avisar");
          } else {
            const lines = order.items
              .map(
                (i) =>
                  `<li>${i.qty}× ${escapeHtml(i.name)} — R$ ${(i.priceCents / 100).toFixed(2)}</li>`,
              )
              .join("");
            const link = `${env.WEB_ORIGIN}/gestao/${order.store.slug}/pedidos`;
            await deps.email.send({
              to,
              // O assunto é a notificação: quem lê no celular precisa saber que vendeu sem
              // abrir o e-mail.
              subject: `Novo pedido pago: R$ ${(order.totalCents / 100).toFixed(2)} — ${order.store.name}`,
              html: `<p>Boa notícia: você vendeu.</p><ul>${lines}</ul><p>Total: <strong>R$ ${(order.totalCents / 100).toFixed(2)}</strong></p><p>Cliente: ${escapeHtml(order.user.name)} — telefone ${escapeHtml(order.contactPhone)}</p>${order.note ? `<p>Recado do cliente: ${escapeHtml(order.note)}</p>` : ""}<p><strong>Próximo passo:</strong> fale com essa pessoa para combinar a entrega.</p><p><a href="${link}">Abrir os pedidos da loja</a></p>`,
            });
          }
        }
      } else if (event.type === "donation.received.store") {
        const { donationId } = event.payload as { donationId: string };
        const donation = await deps.db.donation.findFirst({
          where: { id: donationId, status: "paid" },
          include: {
            user: { select: { name: true } },
            store: { select: { slug: true, name: true } },
            campaign: { select: { title: true } },
          },
        });
        if (donation) {
          const to = await storeInbox(deps.db, donation.storeId);
          if (to.length === 0) {
            deps.log.warn({ donationId }, "doação recebida sem ninguém com e-mail na loja");
          } else {
            // Doação anônima é anônima também para quem recebe: o nome não entra.
            const quem = donation.anonymous ? "Alguém (anônimo)" : escapeHtml(donation.user.name);
            const destino = donation.campaign
              ? ` para a campanha “${escapeHtml(donation.campaign.title)}”`
              : "";
            const link = `${env.WEB_ORIGIN}/gestao/${donation.store.slug}/doacoes`;
            await deps.email.send({
              to,
              subject: `Nova doação: R$ ${(donation.amountCents / 100).toFixed(2)} — ${donation.store.name}`,
              html: `<p>${quem} doou <strong>R$ ${(donation.amountCents / 100).toFixed(2)}</strong>${destino}.</p>${donation.message ? `<p>Mensagem: ${escapeHtml(donation.message)}</p>` : ""}<p><a href="${link}">Ver as doações da loja</a></p>`,
            });
          }
        }
      } else if (event.type === "interest.notified") {
        const { interestId } = event.payload as { interestId: string };
        // Guardado por status: um cancelamento (ou reabertura, ou conversão por um
        // order.paid que chegou primeiro) entre o enfileiramento e este tick não deve
        // gerar o email de "chegou".
        const interest = await deps.db.productInterest.findFirst({
          where: { id: interestId, status: "notified" },
          include: {
            user: { select: { email: true, name: true } },
            product: { select: { name: true, store: { select: { name: true } } } },
          },
        });
        if (interest) {
          // Quem pediu aviso deixando só telefone não recebe e-mail: quem cuida da loja fala
          // por WhatsApp, com o número que aparece na fila de encomendas.
          if (!interest.user.email) {
            deps.log.info({ interestId }, "interest.notified sem e-mail: aviso manual pela loja");
          } else {
            await deps.email.send({
              to: interest.user.email,
              subject: `Chegou: ${interest.product.name} — ${interest.product.store.name}`,
              html: `<p>Olá, ${escapeHtml(interest.user.name)}!</p><p>O produto <strong>${escapeHtml(interest.product.name)}</strong> que você encomendou em ${escapeHtml(interest.product.store.name)} chegou.</p><p>Sua encomenda era de ${interest.qty} unidade(s). É só acessar a loja para finalizar o pedido — quem chega antes garante.</p><p>Com carinho, quem cuida de ${escapeHtml(interest.product.store.name)}.</p>`,
            });
          }
        }
        // Nota: se o interesse sumiu (produto apagado), o evento é marcado processed do
        // mesmo jeito — não há o que notificar.
      } else if (event.type === "donation.received") {
        const { donationId } = event.payload as { donationId: string };
        const donation = await deps.db.donation.findFirst({
          where: { id: donationId, status: "paid" },
          include: {
            user: { select: { email: true, name: true } },
            store: { select: { name: true } },
            campaign: { select: { title: true } },
          },
        });
        if (donation) {
          // Antes do email: é reivindicado por raffleGranted (idempotente), então uma
          // falha de envio nunca perde números e o retry nunca reenvia email por causa
          // deles.
          await createRafflesRepository(deps.db).grantNumbersForDonation(donation.id, deps.log);
          const destino = donation.campaign
            ? `a campanha “${escapeHtml(donation.campaign.title)}”`
            : escapeHtml(donation.store.name);
          // Doação sem conta e sem e-mail: o recibo é a própria tela de confirmação, que a
          // pessoa acompanha pelo link com o token. Os números do sorteio já foram concedidos
          // acima, então nada se perde por não haver e-mail.
          if (!donation.user.email) {
            deps.log.info({ donationId }, "donation.received sem e-mail: recibo só na tela");
          } else {
            await deps.email.send({
              to: donation.user.email,
              subject: `Recebemos sua doação — ${donation.store.name}`,
              html: `<p>Olá, ${escapeHtml(donation.user.name)}!</p><p>Sua doação de R$ ${(donation.amountCents / 100).toFixed(2)} para ${destino} foi confirmada.</p><p>Obrigado por caminhar junto com a gente.</p><p>Com carinho, quem cuida de ${escapeHtml(donation.store.name)}.</p>`,
            });
          }
        }
      } else if (event.type === "payment.orphaned") {
        // Money captured for an aggregate (order or donation) that is no longer pending.
        // No email — this is an operator alert, not a customer-facing message. Durable +
        // queryable via this row; logging here just surfaces it in real time too.
        const { orderId, donationId, paymentId } = event.payload as {
          orderId?: string;
          donationId?: string;
          paymentId: string;
        };
        deps.log.error(
          { orderId, donationId, paymentId },
          "pagamento órfão: pagamento capturado para agregado não pendente, reembolso manual necessário",
        );
      } else if (event.type === "woovi.withdraw") {
        // Tira o saldo virtual da subconta e manda para a chave Pix do núcleo. É o passo
        // que faz a promessa "o dinheiro vai direto para quem organiza" ser verdade no
        // Pix: sem ele o valor fica parado na conta da plataforma.
        const { pixKey, storeId } = event.payload as { pixKey: string; storeId: string };
        const result = await deps.woovi.withdrawSubAccount(pixKey);
        if (result.status === "blocked") {
          // Não é falha nossa e retry não resolve: a Woovi bloqueou a subconta. Fica
          // registrado para quem opera resolver com o núcleo.
          deps.log.error(
            { storeId, motivo: result.message },
            "saque Woovi bloqueado: dinheiro do núcleo retido na conta da plataforma",
          );
        } else if (result.status === "requested") {
          deps.log.info({ storeId }, "saque Woovi pedido");
        }
      } else if (event.type === "raffle.drawn") {
        const { raffleId } = event.payload as { raffleId: string };
        const prizes = await deps.db.rafflePrize.findMany({
          where: { raffleId, winnerEntryId: { not: null } },
          orderBy: { position: "asc" },
          include: {
            raffle: {
              select: { campaign: { select: { title: true, store: { select: { name: true } } } } },
            },
            winnerEntry: { include: { user: { select: { email: true, name: true } } } },
          },
        });
        for (const prize of prizes) {
          const winner = prize.winnerEntry;
          if (!winner) continue;
          const campaign = prize.raffle.campaign;
          // Ganhador que doou sem conta pode não ter e-mail. O sorteio já está registrado e a
          // loja tem o telefone: o aviso vira contato humano, não um envio perdido.
          if (!winner.user.email) {
            deps.log.warn(
              { prizeId: prize.id, entryId: winner.id },
              "sorteio: ganhador sem e-mail, avisar pelo telefone",
            );
            continue;
          }
          await deps.email.send({
            to: winner.user.email,
            subject: `Você foi sorteado — ${campaign.title}`,
            html: `<p>Olá, ${escapeHtml(winner.user.name)}!</p><p>O sorteio da campanha “${escapeHtml(campaign.title)}”, de ${escapeHtml(campaign.store.name)}, aconteceu — e o seu número <strong>${winner.number}</strong> foi contemplado com: ${escapeHtml(prize.title)}.</p><p>Quem cuida da loja vai entrar em contato para combinar a entrega.</p><p>Obrigado por apoiar essa causa.</p>`,
          });
        }
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
