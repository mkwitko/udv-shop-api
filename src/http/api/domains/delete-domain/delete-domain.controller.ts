import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveStoreForRole } from "../../stores/manage.helpers.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { toDomainStatus } from "../domains.helpers.js";
import { DomainStatusResponse } from "../domains.schema.js";

/** Solta o endereço: a loja volta a atender só pelo link da plataforma. */
export const deleteDomainRoute: FastifyPluginAsync = async (app) => {
  app.delete(
    "/stores/:slug/domain",
    {
      config: { permissions: { any: ["store_owner"] } },
      schema: {
        operationId: "deleteStoreDomain",
        tags: ["domains"],
        params: z.object({ slug: z.string() }),
        response: { 200: DomainStatusResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "owner");
      requireWritableStore(req, store);
      const updated = await createStoresRepository(db).setCustomDomain(store.id, null);
      return toDomainStatus(updated);
    },
  );
};
