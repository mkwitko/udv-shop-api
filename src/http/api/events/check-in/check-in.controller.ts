import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { CheckInBody } from "../events.schema.js";

const Params = z.object({
  slug: z.string(),
  eventSlug: z.string(),
  orderItemId: z.string().uuid(),
});

/**
 * Marca (ou desmarca) presença de uma vaga. Idempotente de propósito: na porta a pessoa
 * toca duas vezes sem querer, e marcar presença de novo não pode virar erro na cara de
 * quem está com a fila esperando.
 */
export const checkInRoute: FastifyPluginAsync = async (app) => {
  app.patch(
    "/stores/:slug/events/:eventSlug/attendees/:orderItemId",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "checkInAttendee",
        tags: ["events"],
        params: Params,
        body: CheckInBody,
        response: { 200: z.object({ checkedInAt: z.string().nullable() }) },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "staff");
      const { orderItemId, eventSlug } = req.params as z.infer<typeof Params>;
      const { present } = req.body as CheckInBody;
      // O item tem de ser deste evento E desta loja: sem as duas checagens, um id de item
      // de outra loja seria marcado por quem tem papel aqui.
      const item = await db.orderItem.findFirst({
        where: {
          id: orderItemId,
          order: { storeId: store.id },
          event: { slug: eventSlug, storeId: store.id },
        },
        select: { id: true },
      });
      if (!item) throw new NotFoundError("attendee_not_found");
      const updated = await db.orderItem.update({
        where: { id: item.id },
        data: { checkedInAt: present ? new Date() : null },
        select: { checkedInAt: true },
      });
      return { checkedInAt: updated.checkedInAt?.toISOString() ?? null };
    },
  );
};
