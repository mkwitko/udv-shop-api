import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { createEventsRepository } from "../events.repository.js";
import { EventResultsResponse, ListEventResultsQuery } from "../events.schema.js";

const Params = z.object({ slug: z.string() });

/**
 * Quanto cada evento deu: vagas garantidas, quem chegou e o dinheiro. Existia espalhado
 * entre a lista de presença (quem veio) e o extrato (quanto entrou), e ninguém conseguia
 * responder "valeu a pena fazer o mutirão?" sem somar à mão.
 *
 * Admin+ como tudo que fala de dinheiro: staff marca presença, não vê receita.
 */
export const listEventResultsRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/stores/:slug/manage/events/results",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "listEventResults",
        tags: ["events"],
        params: Params,
        querystring: ListEventResultsQuery,
        response: { 200: EventResultsResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "admin");
      const { limit, upcoming } = req.query as ListEventResultsQuery;
      const rows = await createEventsRepository(db).listResults({
        storeId: store.id,
        limit,
        includeUpcoming: upcoming,
      });
      return {
        items: rows.map((row) => ({ ...row, at: row.at.toISOString() })),
      };
    },
  );
};
