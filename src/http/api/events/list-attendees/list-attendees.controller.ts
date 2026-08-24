import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { EVENT_ATTENDING_STATUSES, totalSeatsLeft } from "../events.repository.js";
import { AttendeesResponse } from "../events.schema.js";
import { resolveEvent } from "../manage-event.helpers.js";

const Params = z.object({ slug: z.string(), eventSlug: z.string() });

/**
 * Lista de presença de um evento. Nasce dos itens de pedido: quem comprou vaga está aqui,
 * com telefone, quantidade e o botão de marcar presença na porta.
 */
export const listAttendeesRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/stores/:slug/events/:eventSlug/attendees",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "listEventAttendees",
        tags: ["events"],
        params: Params,
        response: { 200: AttendeesResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "staff");
      const { eventSlug } = req.params as z.infer<typeof Params>;
      const event = await resolveEvent(store.id, eventSlug);

      const items = await db.orderItem.findMany({
        where: {
          eventId: event.id,
          order: { storeId: store.id, status: { in: [...EVENT_ATTENDING_STATUSES] } },
        },
        include: {
          order: { select: { id: true, status: true, contactPhone: true, createdAt: true } },
        },
        orderBy: { order: { createdAt: "asc" } },
      });
      // Nome de quem comprou vem do usuário do pedido (conta leve inclusive): é o nome que
      // vai ser chamado na porta.
      const orderIds = [...new Set(items.map((item) => item.order.id))];
      const buyers = await db.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, user: { select: { name: true } } },
      });
      const nameByOrder = new Map(buyers.map((row) => [row.id, row.user.name]));

      const soldQty = items.reduce((sum, item) => sum + item.qty, 0);
      const checkedInQty = items.reduce((sum, item) => sum + (item.checkedInAt ? item.qty : 0), 0);

      return {
        event: {
          slug: event.slug,
          name: event.name,
          at: event.at.toISOString(),
          location: event.location,
        },
        soldQty,
        checkedInQty,
        // vagas livres do evento inteiro: com lotes, quem está na porta quer saber quantas
        // ainda dá para vender hoje, não quantas sobraram no lote da semana passada
        remaining: totalSeatsLeft(event),
        items: items.map((item) => ({
          orderItemId: item.id,
          orderId: item.order.id,
          name: nameByOrder.get(item.order.id) ?? "Sem nome",
          phone: item.order.contactPhone,
          qty: item.qty,
          paidCents: item.priceCents * item.qty,
          orderStatus: item.order.status,
          checkedInAt: item.checkedInAt?.toISOString() ?? null,
        })),
      };
    },
  );
};
