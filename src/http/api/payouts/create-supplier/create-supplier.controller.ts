import { Prisma } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ConflictError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveStoreForRole } from "../manage.helpers.js";
import { createPayoutsRepository, toSupplierResponse } from "../payouts.repository.js";
import { CreateSupplierBody, SupplierResponse } from "../payouts.schema.js";

export const createSupplierRoute: FastifyPluginAsync = async (app) => {
  const repo = createPayoutsRepository(db);
  app.post(
    "/stores/:slug/suppliers",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "createSupplier",
        tags: ["payouts"],
        params: z.object({ slug: z.string() }),
        body: CreateSupplierBody,
        response: { 201: SupplierResponse },
      },
    },
    async (req, reply) => {
      const store = await resolveStoreForRole(req, "admin");
      requireWritableStore(req, store);
      try {
        const supplier = await repo.createSupplier(store.id, req.body as CreateSupplierBody);
        void reply.code(201).send(toSupplierResponse(supplier));
      } catch (err) {
        // Dois cadastros com o mesmo nome viram dois saldos para a mesma pessoa.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new ConflictError("supplier_name_in_use");
        }
        throw err;
      }
    },
  );
};
