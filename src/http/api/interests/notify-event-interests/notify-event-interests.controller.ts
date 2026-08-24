import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { createEventsRepository } from "../../events/events.repository.js";
import { createInterestsRepository } from "../interests.repository.js";
import { NotifyInterestsResponse } from "../interests.schema.js";
import { resolveStoreForRole } from "../manage.helpers.js";

/**
 * Abriu vaga num evento que estava lotado: avisa quem estava na fila. Rota separada da de
 * produto porque o alvo é outro — e porque a loja pensa "abriu vaga", não "chegou estoque".
 */
export const notifyEventInterestsRoute: FastifyPluginAsync = async (app) => {
  const repo = createInterestsRepository(db);
  const events = createEventsRepository(db);
  app.post(
    "/stores/:slug/events/:eventSlug/interests/notify",
    {
      // Avisar dispara email para clientes: exige admin+, não staff.
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "notifyEventInterests",
        tags: ["interests"],
        params: z.object({ slug: z.string(), eventSlug: z.string() }),
        response: { 200: NotifyInterestsResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "admin");
      requireWritableStore(req, store);
      const { eventSlug } = req.params as { eventSlug: string };
      const event = await events.findBySlug(store.id, eventSlug);
      if (!event) throw new NotFoundError("event_not_found");
      const notified = await repo.notifyArrival({ eventId: event.id }, req.log);
      return { notified };
    },
  );
};
