import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { createOrdersRepository } from "../orders.repository.js";
import { OrderReceiptResponse } from "../orders.schema.js";

const Params = z.object({ id: z.string().uuid() });
const Query = z.object({ token: z.string().uuid() });

export const orderReceiptRoute: FastifyPluginAsync = async (app) => {
  const orders = createOrdersRepository(db);
  app.get(
    "/orders/:id/receipt",
    {
      // Público porque quem comprou sem conta não tem sessão para apresentar, e o Pix é
      // assíncrono: sem isso a tela de confirmação entrega um QR code e um beco sem saída. O
      // teto alto é o poll de 4 segundos dessa tela.
      config: { public: true, rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        operationId: "getOrderReceipt",
        tags: ["orders"],
        params: Params,
        querystring: Query,
        response: { 200: OrderReceiptResponse },
      },
    },
    async (req) => {
      const { id } = req.params as z.infer<typeof Params>;
      const { token } = req.query as z.infer<typeof Query>;
      const order = await orders.findByPublicToken(id, token);
      // 404 e não 403: um token errado não confirma que o pedido existe.
      if (!order) throw new NotFoundError("order_not_found");
      return {
        id: order.id,
        status: order.status,
        totalCents: order.totalCents,
        currency: order.currency,
        store: { slug: order.store.slug, name: order.store.name },
        items: order.items.map((i) => ({ name: i.name, qty: i.qty, priceCents: i.priceCents })),
        createdAt: order.createdAt.toISOString(),
      };
    },
  );
};
