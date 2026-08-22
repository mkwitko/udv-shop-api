import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { optionalUser } from "../../../hooks/optional-user.js";
import { createProductsRepository, toProductResponse } from "../../products/products.repository.js";
import { assertStoreReadable } from "../../stores/store-visibility.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { EventsListQuery, EventsListResponse } from "../events.schema.js";

const Params = z.object({ slug: z.string() });

/**
 * Agenda da loja: o que ainda vai acontecer, do mais próximo ao mais distante. Evento que
 * já passou sai sozinho da lista — vender ingresso para ontem seria pegar dinheiro por
 * nada, e é o tipo de erro que ninguém percebe até alguém reclamar.
 */
export const listEventsRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/stores/:slug/events",
    {
      config: { public: true },
      schema: {
        operationId: "listEvents",
        tags: ["events"],
        params: Params,
        querystring: EventsListQuery,
        response: { 200: EventsListResponse },
      },
    },
    async (req) => {
      const store = await createStoresRepository(db).findBySlug(
        (req.params as z.infer<typeof Params>).slug,
      );
      assertStoreReadable(store, await optionalUser(req));
      const { limit } = req.query as EventsListQuery;
      const rows = await createProductsRepository(db).listUpcomingEvents(store.id, limit);
      return { items: rows.map((row) => toProductResponse(row, app.gateways.r2.publicUrl)) };
    },
  );
};
