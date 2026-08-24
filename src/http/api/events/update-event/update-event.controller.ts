import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { assertPayoutForStore } from "../../products/product-payout.js";
import { createEventsRepository, toEventResponse } from "../events.repository.js";
import { EventResponse, UpdateEventBody } from "../events.schema.js";
import {
  assertBatchWindows,
  assertEventWindow,
  resolveEvent,
  resolveStoreForEvents,
} from "../manage-event.helpers.js";

const Params = z.object({ slug: z.string(), eventSlug: z.string() });

export const updateEventRoute: FastifyPluginAsync = async (app) => {
  app.patch(
    "/stores/:slug/events/:eventSlug",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "updateEvent",
        tags: ["events"],
        params: Params,
        body: UpdateEventBody,
        response: { 200: EventResponse },
      },
    },
    async (req) => {
      const { slug, eventSlug } = req.params as z.infer<typeof Params>;
      const store = await resolveStoreForEvents(req, slug);
      const current = await resolveEvent(store.id, eventSlug);
      const body = req.body as UpdateEventBody;

      // Intervalo e repasse são validados com o que vai ficar valendo, misturando o que já
      // está gravado com o que o formulário mandou — validar só o corpo deixaria passar
      // combinação inválida vinda de edição parcial.
      assertEventWindow({
        at: body.at !== undefined ? new Date(body.at) : current.at,
        endsAt:
          body.endsAt !== undefined ? (body.endsAt ? new Date(body.endsAt) : null) : current.endsAt,
      });
      await assertPayoutForStore(store, {
        supplierId: body.supplierId !== undefined ? body.supplierId : current.supplierId,
        payoutKind: body.payoutKind !== undefined ? body.payoutKind : current.payoutKind,
        payoutValue: body.payoutValue !== undefined ? body.payoutValue : current.payoutValue,
        priceCents: body.priceCents ?? current.priceCents,
      });

      const repo = createEventsRepository(db);
      // Lotes primeiro: se um deles for recusado (vaga já vendida), o resto da edição não
      // fica gravado pela metade em cima de uma lista de lotes que não mudou.
      if (body.batches !== undefined) {
        assertBatchWindows(body.batches);
        await repo.replaceBatches(current.id, body.batches);
      }
      const updated = await repo.update(current.id, body);
      return toEventResponse(updated, app.gateways.r2.publicUrl, { payout: true });
    },
  );
};
