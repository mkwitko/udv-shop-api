import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { resolveStoreForRole } from "../manage.helpers.js";
import { createPayoutsRepository, toSupplierResponse } from "../payouts.repository.js";
import { PayoutDetailResponse } from "../payouts.schema.js";

const Params = z.object({ slug: z.string(), supplierId: z.string().uuid() });
const RECENT = 50;

export const getPayoutRoute: FastifyPluginAsync = async (app) => {
  const repo = createPayoutsRepository(db);
  app.get(
    "/stores/:slug/payouts/:supplierId",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "getPayout",
        tags: ["payouts"],
        params: Params,
        response: { 200: PayoutDetailResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "admin");
      const { supplierId } = req.params as z.infer<typeof Params>;
      const supplier = await repo.findSupplier(store.id, supplierId);
      if (!supplier) throw new NotFoundError("supplier_not_found");

      const [totals, sales, settlements] = await Promise.all([
        repo.totalsBySupplier(store.id, supplier.id),
        repo.listSales(store.id, supplier.id, RECENT),
        repo.listSettlements(supplier.id, RECENT),
      ]);

      return {
        supplier: toSupplierResponse(supplier),
        earnedCents: totals.earnedCents,
        settledCents: totals.settledCents,
        balanceCents: totals.earnedCents - totals.settledCents,
        sales: sales.map((sale) => ({ ...sale, soldAt: sale.soldAt.toISOString() })),
        settlements: settlements.map((row) => ({ ...row, paidAt: row.paidAt.toISOString() })),
      };
    },
  );
};
