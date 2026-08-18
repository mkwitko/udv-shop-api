import { Prisma } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ConflictError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveStoreForRole } from "../../stores/manage.helpers.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { parseStoreDomain, toDomainStatus } from "../domains.helpers.js";
import { DomainStatusResponse, PutDomainBody } from "../domains.schema.js";

export const putDomainRoute: FastifyPluginAsync = async (app) => {
  app.put(
    "/stores/:slug/domain",
    {
      // endereço da loja é decisão de quem responde por ela: owner apenas
      config: { permissions: { any: ["store_owner"] } },
      schema: {
        operationId: "putStoreDomain",
        tags: ["domains"],
        params: z.object({ slug: z.string() }),
        body: PutDomainBody,
        response: { 200: DomainStatusResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "owner");
      requireWritableStore(req, store);
      const domain = parseStoreDomain((req.body as PutDomainBody).domain);
      try {
        const updated = await createStoresRepository(db).setCustomDomain(store.id, domain);
        return toDomainStatus(updated);
      } catch (err) {
        // duas lojas com o mesmo endereço não é ambiguidade: é briga por tráfego
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new ConflictError("domain_in_use");
        }
        throw err;
      }
    },
  );
};
