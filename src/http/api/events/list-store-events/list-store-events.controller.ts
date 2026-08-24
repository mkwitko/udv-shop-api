import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { createEventsRepository, toEventResponse } from "../events.repository.js";
import { EventsListResponse, ListStoreEventsQuery } from "../events.schema.js";

const Params = z.object({ slug: z.string() });

/**
 * Agenda de quem cuida da loja. Diferente da pública em duas coisas: mostra o que já passou
 * (é onde fica a lista de presença de ontem) e o que foi arquivado, e traz o acordo de
 * repasse de quem conduz.
 */
export const listStoreEventsRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/stores/:slug/manage/events",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "listStoreEvents",
        tags: ["events"],
        params: Params,
        querystring: ListStoreEventsQuery,
        response: { 200: EventsListResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "staff");
      const { limit, all } = req.query as ListStoreEventsQuery;
      const rows = await createEventsRepository(db).listByStore({
        storeId: store.id,
        limit,
        includePast: all,
      });
      return {
        items: rows.map((row) => toEventResponse(row, app.gateways.r2.publicUrl, { payout: true })),
      };
    },
  );
};
