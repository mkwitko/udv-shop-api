import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ValidationError } from "../../../../shared/errors.js";
import { resolveStoreForRole } from "../../stores/manage.helpers.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { domainTarget, toDomainStatus } from "../domains.helpers.js";
import { VerifyDomainResponse } from "../domains.schema.js";

/**
 * Consulta o DNS agora e grava o resultado. Verificação não é permanente por acaso:
 * se o CNAME sair do ar, a próxima verificação desfaz — e o domínio para de resolver.
 */
export const verifyDomainRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/stores/:slug/domain/verify",
    {
      config: { permissions: { any: ["store_owner"] } },
      schema: {
        operationId: "verifyStoreDomain",
        tags: ["domains"],
        params: z.object({ slug: z.string() }),
        response: { 200: VerifyDomainResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "owner");
      const target = domainTarget();
      if (target === "") throw new ValidationError("custom_domain_disabled");
      if (!store.customDomain) throw new ValidationError("domain_not_set");

      const found = await app.gateways.dns.resolveCname(store.customDomain);
      const ok = found.includes(target);
      const updated = await createStoresRepository(db).markDomainVerified(
        store.id,
        ok ? new Date() : null,
      );
      return { ...toDomainStatus(updated), found };
    },
  );
};
