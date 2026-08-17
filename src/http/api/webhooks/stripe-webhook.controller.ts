import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../infra/db/client.js";
import { UnauthorizedError, ValidationError } from "../../../shared/errors.js";
import { processWebhookEvents } from "../../../workers/webhook-processor.js";
import { storeWebhookEvent } from "./webhook-events.repository.js";

export const stripeWebhookRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/webhooks/stripe",
    {
      config: { public: true },
      schema: {
        operationId: "stripeWebhook",
        tags: ["webhooks"],
        response: { 200: z.object({ received: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const signature = req.headers["stripe-signature"];
      if (typeof signature !== "string") throw new ValidationError("missing_signature");
      const raw = req.body as Buffer;
      let event: { id: string; type: string };
      try {
        event = app.gateways.stripe.verifyWebhook(raw, signature);
      } catch {
        throw new UnauthorizedError("invalid_signature");
      }
      const isNew = await storeWebhookEvent(db, {
        provider: "stripe",
        eventId: event.id,
        type: event.type,
        payload: JSON.parse(raw.toString("utf8")),
      });
      if (isNew) await processWebhookEvents({ db, log: req.log });
      return reply.send({ received: true });
    },
  );
};
