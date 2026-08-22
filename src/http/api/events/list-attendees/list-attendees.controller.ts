import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { createProductsRepository } from "../../products/products.repository.js";
import { AttendeesResponse } from "../events.schema.js";

const Params = z.object({ slug: z.string(), productSlug: z.string() });

// Pedido cancelado ou expirado não leva ninguém à porta; reembolsado desistiu. A lista é de
// quem pagou e de quem ainda pode pagar — a loja precisa ver o "aguardando pagamento" para
// não achar que a pessoa vai aparecer com ingresso quitado.
const COUNTS_AS_ATTENDING = ["pending_payment", "paid", "delivery_arranged", "delivered"] as const;

/**
 * Lista de presença de um evento. Nasce dos itens de pedido: quem comprou ingresso está
 * aqui, com telefone, quantidade e o botão de marcar presença na porta.
 */
export const listAttendeesRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/stores/:slug/events/:productSlug/attendees",
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
      const { productSlug } = req.params as z.infer<typeof Params>;
      const product = await createProductsRepository(db).findBySlug(store.id, productSlug);
      if (!product || !product.eventAt) throw new NotFoundError("event_not_found");

      const items = await db.orderItem.findMany({
        where: {
          productId: product.id,
          order: { storeId: store.id, status: { in: [...COUNTS_AS_ATTENDING] } },
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
          slug: product.slug,
          name: product.name,
          at: product.eventAt.toISOString(),
          location: product.eventLocation,
        },
        soldQty,
        checkedInQty,
        // vagas restantes é o estoque, que a reserva do checkout já decrementa
        remaining: product.stock,
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
