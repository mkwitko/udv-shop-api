import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { optionalUser } from "../../../hooks/optional-user.js";
import { assertStoreReadable, isStoreMember } from "../../stores/store-visibility.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { createEventsRepository, toEventResponse } from "../events.repository.js";
import { EventResponse } from "../events.schema.js";

const Params = z.object({ slug: z.string(), eventSlug: z.string() });

/**
 * Página pública do evento. Evento que já passou continua abrindo de propósito: o link
 * circula no grupo depois da data, e "essa sessão já aconteceu" é resposta melhor que 404.
 * Quem barra a venda é o checkout.
 */
export const getEventRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/stores/:slug/events/:eventSlug",
    {
      config: { public: true },
      schema: {
        operationId: "getEvent",
        tags: ["events"],
        params: Params,
        response: { 200: EventResponse },
      },
    },
    async (req) => {
      const { slug, eventSlug } = req.params as z.infer<typeof Params>;
      const store = await createStoresRepository(db).findBySlug(slug);
      const user = await optionalUser(req);
      assertStoreReadable(store, user);
      const isMember = isStoreMember(user, store.id);
      const event = await createEventsRepository(db).findBySlug(store.id, eventSlug);
      if (!event || (!event.active && !isMember)) throw new NotFoundError("event_not_found");
      return toEventResponse(event, app.gateways.r2.publicUrl, { payout: isMember });
    },
  );
};
