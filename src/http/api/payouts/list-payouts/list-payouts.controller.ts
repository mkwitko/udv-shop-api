import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { resolveStoreForRole } from "../manage.helpers.js";
import { createPayoutsRepository, toSupplierResponse } from "../payouts.repository.js";
import { PayoutsResponse } from "../payouts.schema.js";

/** Cadastro de parceiros de uma loja é pequeno; o teto evita resposta sem limite. */
const MAX_SUPPLIERS = 200;

export const listPayoutsRoute: FastifyPluginAsync = async (app) => {
  const repo = createPayoutsRepository(db);
  app.get(
    "/stores/:slug/payouts",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "listPayouts",
        tags: ["payouts"],
        params: z.object({ slug: z.string() }),
        response: { 200: PayoutsResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "admin");
      const [suppliers, totals] = await Promise.all([
        repo.listAllSuppliers(store.id, MAX_SUPPLIERS),
        repo.totalsByStore(store.id),
      ]);

      const items = suppliers
        .map((supplier) => {
          const sum = totals.get(supplier.id) ?? { earnedCents: 0, settledCents: 0 };
          return {
            supplier: toSupplierResponse(supplier),
            earnedCents: sum.earnedCents,
            settledCents: sum.settledCents,
            balanceCents: sum.earnedCents - sum.settledCents,
          };
        })
        // parceiro desativado só continua na lista enquanto houver conta aberta
        .filter((row) => row.supplier.active || row.earnedCents > 0 || row.settledCents > 0);

      const totalsResponse = items.reduce(
        (acc, row) => ({
          earnedCents: acc.earnedCents + row.earnedCents,
          settledCents: acc.settledCents + row.settledCents,
          balanceCents: acc.balanceCents + row.balanceCents,
        }),
        { earnedCents: 0, settledCents: 0, balanceCents: 0 },
      );

      return { items, totals: totalsResponse };
    },
  );
};
