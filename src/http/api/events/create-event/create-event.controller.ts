import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ConflictError } from "../../../../shared/errors.js";
import { assertPayoutForStore } from "../../products/product-payout.js";
import { createEventsRepository, toEventResponse } from "../events.repository.js";
import { CreateEventBody, EventResponse } from "../events.schema.js";
import {
  assertBatchWindows,
  assertEventWindow,
  resolveStoreForEvents,
} from "../manage-event.helpers.js";

const Params = z.object({ slug: z.string() });

/** Cria um evento na agenda da loja. Vaga é o que se vende; data e lugar são o que ele é. */
export const createEventRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/stores/:slug/events",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "createEvent",
        tags: ["events"],
        params: Params,
        body: CreateEventBody,
        response: { 201: EventResponse },
      },
    },
    async (req, reply) => {
      const store = await resolveStoreForEvents(req, (req.params as z.infer<typeof Params>).slug);
      const body = req.body as CreateEventBody;
      assertEventWindow({
        at: new Date(body.at),
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
      });
      assertBatchWindows(body.batches ?? []);
      await assertPayoutForStore(store, { ...body, priceCents: body.priceCents });

      const repo = createEventsRepository(db);
      // O endereço do evento é o que viaja no grupo de WhatsApp: repetido, o link antigo
      // passaria a abrir a sessão nova.
      if (await repo.findBySlug(store.id, body.slug)) throw new ConflictError("event_slug_taken");

      const event = await repo.create(store.id, body);
      void reply
        .code(201)
        .send(toEventResponse(event, app.gateways.r2.publicUrl, { payout: true }));
    },
  );
};
