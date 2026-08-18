import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireUser } from "../../../hooks/auth.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveStoreForRole } from "../manage.helpers.js";
import { createPayoutsRepository } from "../payouts.repository.js";
import { CreateSettlementBody, SettlementResponse } from "../payouts.schema.js";

const Params = z.object({ slug: z.string(), supplierId: z.string().uuid() });

export const createSettlementRoute: FastifyPluginAsync = async (app) => {
  const repo = createPayoutsRepository(db);
  app.post(
    "/stores/:slug/payouts/:supplierId/settlements",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "createSettlement",
        tags: ["payouts"],
        params: Params,
        body: CreateSettlementBody,
        response: { 201: SettlementResponse },
      },
    },
    async (req, reply) => {
      const store = await resolveStoreForRole(req, "admin");
      requireWritableStore(req, store);
      const user = requireUser(req);
      const { supplierId } = req.params as z.infer<typeof Params>;
      const body = req.body as CreateSettlementBody;
      const supplier = await repo.findSupplier(store.id, supplierId);
      if (!supplier) throw new NotFoundError("supplier_not_found");

      // Pagar mais do que o saldo é permitido: adiantamento existe, e um reembolso
      // depois do repasse também deixa o saldo negativo. Negativo = crédito da loja.
      const created = await repo.createSettlement({
        storeId: store.id,
        supplierId: supplier.id,
        amountCents: body.amountCents,
        note: body.note ?? null,
        paidAt: body.paidAt ? new Date(body.paidAt) : new Date(),
        createdById: user.sub,
      });
      const totals = await repo.totalsBySupplier(store.id, supplier.id);

      void reply.code(201).send({
        id: created.id,
        supplierId: supplier.id,
        amountCents: body.amountCents,
        note: body.note ?? null,
        paidAt: created.paidAt.toISOString(),
        balanceCents: totals.earnedCents - totals.settledCents,
      });
    },
  );
};
