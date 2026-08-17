import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../infra/db/client.js";
import { UnauthorizedError, ValidationError } from "../../../shared/errors.js";
import { processWebhookEvents } from "../../../workers/webhook-processor.js";
import { storeWebhookEvent } from "./webhook-events.repository.js";

export const wooviWebhookRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/webhooks/woovi",
    {
      config: { public: true },
      schema: {
        operationId: "wooviWebhook",
        tags: ["webhooks"],
        response: { 200: z.object({ received: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const signature = req.headers["x-openpix-signature"];
      if (typeof signature !== "string") throw new ValidationError("missing_signature");
      const raw = req.body as Buffer;
      if (!app.gateways.woovi.verifyWebhook(raw, signature)) {
        throw new UnauthorizedError("invalid_signature");
      }
      const payload = JSON.parse(raw.toString("utf8")) as {
        event?: string;
        charge?: { correlationID?: string };
      };
      const type = payload.event ?? "unknown";
      const correlationID = payload.charge?.correlationID ?? "none";
      const isNew = await storeWebhookEvent(db, {
        provider: "woovi",
        eventId: `${type}:${correlationID}`,
        type,
        payload: JSON.parse(raw.toString("utf8")),
      });
      if (isNew) await processWebhookEvents({ db, log: req.log });
      return reply.send({ received: true });
    },
  );
};
