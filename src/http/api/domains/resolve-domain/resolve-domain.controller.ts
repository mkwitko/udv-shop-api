import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { normalizeDomain } from "../../../../lib/domain.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { createStoresRepository, toStoreResponse } from "../../stores/stores.repository.js";
import { StoreResponse } from "../../stores/stores.schema.js";

const Query = z.object({ host: z.string().min(3).max(255) });

/**
 * O front pergunta "de quem é este host?" no SSR, antes de renderizar. Público de
 * propósito: é a porta de entrada de quem digitou o endereço da loja no navegador.
 * Loja suspensa continua resolvendo — a página dela é que diz que está fora do ar.
 */
export const resolveDomainRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/stores/by-domain",
    {
      config: { public: true },
      schema: {
        operationId: "resolveStoreDomain",
        tags: ["domains"],
        querystring: Query,
        response: { 200: StoreResponse },
      },
    },
    async (req) => {
      const { host } = req.query as z.infer<typeof Query>;
      const domain = normalizeDomain(host);
      if (!domain) throw new NotFoundError("store_not_found");
      const store = await createStoresRepository(db).findByVerifiedDomain(domain);
      if (!store) throw new NotFoundError("store_not_found");
      return toStoreResponse(store, app.gateways.r2.publicUrl);
    },
  );
};
