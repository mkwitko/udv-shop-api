import { Prisma } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ConflictError, NotFoundError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveStoreForRole } from "../manage.helpers.js";
import { createPayoutsRepository, toSupplierResponse } from "../payouts.repository.js";
import { SupplierResponse, UpdateSupplierBody } from "../payouts.schema.js";

const Params = z.object({ slug: z.string(), supplierId: z.string().uuid() });

export const updateSupplierRoute: FastifyPluginAsync = async (app) => {
  const repo = createPayoutsRepository(db);
  app.patch(
    "/stores/:slug/suppliers/:supplierId",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "updateSupplier",
        tags: ["payouts"],
        params: Params,
        body: UpdateSupplierBody,
        response: { 200: SupplierResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "admin");
      requireWritableStore(req, store);
      const { supplierId } = req.params as z.infer<typeof Params>;
      const supplier = await repo.findSupplier(store.id, supplierId);
      if (!supplier) throw new NotFoundError("supplier_not_found");
      try {
        // Parceiro nunca é apagado: `active: false` tira das opções e o histórico fica.
        const updated = await repo.updateSupplier(supplier.id, req.body as UpdateSupplierBody);
        return toSupplierResponse(updated);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new ConflictError("supplier_name_in_use");
        }
        throw err;
      }
    },
  );
};
