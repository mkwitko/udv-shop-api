import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError, ServiceUnavailableError } from "../../../../shared/errors.js";
import { requireStoreRole, requireWritableStore } from "../../../hooks/store-role.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { SuggestDescriptionBody, SuggestDescriptionResponse } from "../products.schema.js";

const Params = z.object({ slug: z.string() });

/**
 * Sugestão de descrição escrita pela IA. Não grava nada: devolve texto para a tela
 * mostrar, e quem decide se aquilo vai para o produto é a loja. O limite de 10/min por
 * IP existe porque cada chamada gasta cota diária da conta da plataforma.
 */
export const suggestDescriptionRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/stores/:slug/products/description-suggestion",
    {
      config: {
        permissions: { any: ["store_owner", "store_admin", "store_staff"] },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      schema: {
        operationId: "suggestProductDescription",
        tags: ["products"],
        params: Params,
        body: SuggestDescriptionBody,
        response: { 200: SuggestDescriptionResponse },
      },
    },
    async (req) => {
      const { slug } = req.params as z.infer<typeof Params>;
      const store = await createStoresRepository(db).findBySlug(slug);
      if (!store) throw new NotFoundError("store not found");
      requireStoreRole(req, store.id, "staff");
      requireWritableStore(req, store);

      if (!app.gateways.ai.configured) throw new ServiceUnavailableError("ai_not_configured");

      const body = req.body as SuggestDescriptionBody;
      const text = await app.gateways.ai.writeProductDescription({
        productName: body.name,
        draft: body.draft,
        mode: body.mode,
        instruction: body.instruction,
        storeName: store.name,
      });
      return { text };
    },
  );
};
