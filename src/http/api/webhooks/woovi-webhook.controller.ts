import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../infra/db/client.js";
import { UnauthorizedError } from "../../../shared/errors.js";
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
      // A Woovi só registra um webhook depois de bater na URL e receber 200, e essa chamada
      // de teste não tem como vir assinada: a secret nasce junto com o registro. Responder
      // 200 sem processar nada é o que permite cadastrar o webhook — requisição sem
      // assinatura continua não virando evento, que é o que a verificação protege.
      if (typeof signature !== "string") {
        req.log.warn("webhook da Woovi sem assinatura: respondido 200 sem processar");
        return reply.send({ received: true });
      }
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
      const stored = await storeWebhookEvent(db, {
        provider: "woovi",
        eventId: `${type}:${correlationID}`,
        type,
        payload: JSON.parse(raw.toString("utf8")),
      });
      if (stored) await processWebhookEvents({ db, log: req.log, eventId: stored.id });
      return reply.send({ received: true });
    },
  );
};
