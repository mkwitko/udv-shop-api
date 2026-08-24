import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { csvDateTime, toCsv } from "../../../../lib/csv.js";
import { resolveStoreForRole } from "../../stores/manage.helpers.js";
import { createReportsRepository } from "../reports.repository.js";
import { type ExportQuery, ExportQuery as ExportQuerySchema } from "../reports.schema.js";

const STATUS_LABEL: Record<string, string> = {
  open: "esperando",
  notified: "avisado",
  converted: "comprou",
  cancelled: "desistiu",
};

/** Fora do OpenAPI: devolve arquivo, não JSON. Ver export-orders. */
export const exportInterestsRoute: FastifyPluginAsync = async (app) => {
  const repo = createReportsRepository(db);
  app.get(
    "/stores/:slug/interests.csv",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "exportInterests",
        tags: ["reports"],
        hide: true,
        params: z.object({ slug: z.string() }),
        querystring: ExportQuerySchema,
      },
    },
    async (req, reply) => {
      const store = await resolveStoreForRole(req, "admin");
      const { limit } = req.query as ExportQuery;
      const rows = await repo.exportInterests(store.id, limit);
      const csv = toCsv(
        // "Item" e não "Produto": a fila também tem vaga de evento lotado
        ["Data", "Item", "Pessoa", "Telefone", "Quantidade", "Situação"],
        rows.map((row) => [
          csvDateTime(row.createdAt),
          row.itemName,
          row.customerName,
          row.customerPhone ?? "",
          row.qty,
          STATUS_LABEL[row.status] ?? row.status,
        ]),
      );
      void reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="encomendas-${store.slug}.csv"`)
        .send(csv);
    },
  );
};
