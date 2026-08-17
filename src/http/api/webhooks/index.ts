import type { FastifyPluginAsync } from "fastify";
import { stripeWebhookRoute } from "./stripe-webhook.controller.js";
import { wooviWebhookRoute } from "./woovi-webhook.controller.js";

export const webhooksRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
    done(null, body),
  );
  await app.register(stripeWebhookRoute);
  await app.register(wooviWebhookRoute);
};
