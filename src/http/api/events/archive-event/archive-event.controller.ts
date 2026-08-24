import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { createEventsRepository } from "../events.repository.js";
import { resolveEvent, resolveStoreForEvents } from "../manage-event.helpers.js";

const Params = z.object({ slug: z.string(), eventSlug: z.string() });

/**
 * Tira o evento da agenda sem apagar. Apagar levaria embora a lista de presença e o que os
 * pedidos já compraram — o registro de quem esteve na porta é da loja.
 */
export const archiveEventRoute: FastifyPluginAsync = async (app) => {
  app.delete(
    "/stores/:slug/events/:eventSlug",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "archiveEvent",
        tags: ["events"],
        params: Params,
        response: { 204: z.null().describe("No Content") },
      },
    },
    async (req, reply) => {
      const { slug, eventSlug } = req.params as z.infer<typeof Params>;
      const store = await resolveStoreForEvents(req, slug);
      const event = await resolveEvent(store.id, eventSlug);
      await createEventsRepository(db).archive(event.id);
      void reply.code(204).send();
    },
  );
};
