import type { FastifyPluginAsync } from "fastify";
import { ServiceUnavailableError } from "../../../../shared/errors.js";
import { SuggestStoreDescriptionBody, SuggestStoreDescriptionResponse } from "../stores.schema.js";

/**
 * Sugestão de descrição da loja. Basta estar logado: no cadastro ainda não existe loja
 * para checar papel. O teto de 5/min é o mesmo da criação de loja — cada chamada gasta
 * cota diária da conta da plataforma.
 */
export const suggestStoreDescriptionRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/store-description-suggestion",
    {
      config: {
        permissions: { any: ["customer"] },
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
      schema: {
        operationId: "suggestStoreDescription",
        tags: ["stores"],
        body: SuggestStoreDescriptionBody,
        response: { 200: SuggestStoreDescriptionResponse },
      },
    },
    async (req) => {
      if (!app.gateways.ai.configured) throw new ServiceUnavailableError("ai_not_configured");
      const body = req.body as SuggestStoreDescriptionBody;
      const text = await app.gateways.ai.writeStoreDescription({
        storeName: body.name,
        draft: body.draft,
        mode: body.mode,
      });
      return { text };
    },
  );
};
