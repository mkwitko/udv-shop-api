import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { csvDateTime, csvMoney, toCsv } from "../../../../lib/csv.js";
import { resolveStoreForRole } from "../../stores/manage.helpers.js";
import { createReportsRepository } from "../reports.repository.js";
import { type ExportQuery, ExportQuery as ExportQuerySchema } from "../reports.schema.js";

const STATUS_LABEL: Record<string, string> = {
  pending_payment: "aguardando pagamento",
  paid: "pago",
  delivery_arranged: "entrega combinada",
  delivered: "entregue",
  cancelled: "cancelado",
  refunded: "reembolsado",
};

/**
 * `hide: true` mantém a rota fora do OpenAPI de propósito: o cliente gerado espera
 * JSON, e isto devolve um arquivo. O front baixa com um fetch próprio.
 */
export const exportOrdersRoute: FastifyPluginAsync = async (app) => {
  const repo = createReportsRepository(db);
  app.get(
    "/stores/:slug/orders.csv",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "exportOrders",
        tags: ["reports"],
        hide: true,
        params: z.object({ slug: z.string() }),
        querystring: ExportQuerySchema,
      },
    },
    async (req, reply) => {
      const store = await resolveStoreForRole(req, "admin");
      const { limit } = req.query as ExportQuery;
      const rows = await repo.exportOrders(store.id, limit);
      const csv = toCsv(
        ["Data", "Pedido", "Situação", "Cliente", "E-mail", "Telefone", "Itens", "Total"],
        rows.map((row) => [
          csvDateTime(row.createdAt),
          row.id,
          STATUS_LABEL[row.status] ?? row.status,
          row.customerName,
          row.customerEmail,
          row.contactPhone,
          row.items,
          csvMoney(row.totalCents),
        ]),
      );
      void reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="pedidos-${store.slug}.csv"`)
        .send(csv);
    },
  );
};
