import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { resolveStoreForRole } from "../../stores/manage.helpers.js";
import { createReportsRepository } from "../reports.repository.js";
import { StatementQuery, StatementResponse } from "../reports.schema.js";

/** Primeiro dia do mês, `months - 1` meses atrás: o mês corrente conta inteiro. */
function firstDayOfWindow(months: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
}

export const getStatementRoute: FastifyPluginAsync = async (app) => {
  const repo = createReportsRepository(db);
  app.get(
    "/stores/:slug/statement",
    {
      // extrato é dinheiro da loja: admin+, como os repasses
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "getStatement",
        tags: ["reports"],
        params: z.object({ slug: z.string() }),
        querystring: StatementQuery,
        response: { 200: StatementResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "admin");
      const { months } = req.query as StatementQuery;
      const [rows, payoutsOpenCents] = await Promise.all([
        repo.moneyByMonth(store.id, firstDayOfWindow(months)),
        repo.payoutsOpenCents(store.id),
      ]);

      const withNet = rows.map((row) => ({
        ...row,
        netCents:
          row.salesGrossCents +
          row.donationsGrossCents -
          row.feeCents -
          row.providerFeeCents -
          row.payoutCents,
      }));
      const totals = withNet.reduce(
        (acc, row) => ({
          salesCount: acc.salesCount + row.salesCount,
          salesGrossCents: acc.salesGrossCents + row.salesGrossCents,
          donationsCount: acc.donationsCount + row.donationsCount,
          donationsGrossCents: acc.donationsGrossCents + row.donationsGrossCents,
          feeCents: acc.feeCents + row.feeCents,
          providerFeeCents: acc.providerFeeCents + row.providerFeeCents,
          payoutCents: acc.payoutCents + row.payoutCents,
          netCents: acc.netCents + row.netCents,
        }),
        {
          salesCount: 0,
          salesGrossCents: 0,
          donationsCount: 0,
          donationsGrossCents: 0,
          feeCents: 0,
          providerFeeCents: 0,
          payoutCents: 0,
          netCents: 0,
        },
      );

      return { months: withNet, totals, payoutsOpenCents };
    },
  );
};
