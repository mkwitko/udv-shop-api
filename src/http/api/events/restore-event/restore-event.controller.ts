import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { createEventsRepository, toEventResponse } from "../events.repository.js";
import { EventResponse } from "../events.schema.js";
import { resolveEvent, resolveStoreForEvents } from "../manage-event.helpers.js";

const Params = z.object({ slug: z.string(), eventSlug: z.string() });

/** Caminho de volta do arquivar. Evento que já passou volta arquivado do mesmo jeito. */
export const restoreEventRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/stores/:slug/events/:eventSlug/restore",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "restoreEvent",
        tags: ["events"],
        params: Params,
        response: { 200: EventResponse },
      },
    },
    async (req) => {
      const { slug, eventSlug } = req.params as z.infer<typeof Params>;
      const store = await resolveStoreForEvents(req, slug);
      const event = await resolveEvent(store.id, eventSlug);
      const repo = createEventsRepository(db);
      await repo.restore(event.id);
      const restored = await resolveEvent(store.id, eventSlug);
      return toEventResponse(restored, app.gateways.r2.publicUrl, { payout: true });
    },
  );
};
