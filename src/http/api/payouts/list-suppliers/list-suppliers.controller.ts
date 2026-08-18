import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { resolveStoreForRole } from "../manage.helpers.js";
import { createPayoutsRepository, toSupplierResponse } from "../payouts.repository.js";
import { ListSuppliersQuery, SuppliersPageResponse } from "../payouts.schema.js";

export const listSuppliersRoute: FastifyPluginAsync = async (app) => {
  const repo = createPayoutsRepository(db);
  app.get(
    "/stores/:slug/suppliers",
    {
      // Cadastro de parceiro é dado de acordo comercial: staff não vê.
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "listSuppliers",
        tags: ["payouts"],
        params: z.object({ slug: z.string() }),
        querystring: ListSuppliersQuery,
        response: { 200: SuppliersPageResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "admin");
      const { limit, cursor, all } = req.query as ListSuppliersQuery;
      const page = await repo.listSuppliersCursor({
        storeId: store.id,
        limit,
        cursor: cursor ?? null,
        includeInactive: all,
      });
      return { items: page.items.map(toSupplierResponse), nextCursor: page.nextCursor };
    },
  );
};
