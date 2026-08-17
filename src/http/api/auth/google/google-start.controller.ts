import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { env } from "../../../../config/env.js";

const OAUTH_COOKIE_OPTS = {
  path: "/auth",
  httpOnly: true,
  sameSite: "lax",
  signed: true,
  secure: env.NODE_ENV === "production",
  maxAge: 600,
} as const;

export const googleStartRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/auth/google/start",
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { operationId: "googleStart", tags: ["auth"] },
    },
    async (_req, reply) => {
      const state = randomBytes(16).toString("base64url");
      const nonce = randomBytes(16).toString("base64url");
      void reply.setCookie("udv_oauth_state", state, OAUTH_COOKIE_OPTS);
      void reply.setCookie("udv_oauth_nonce", nonce, OAUTH_COOKIE_OPTS);
      void reply.redirect(app.gateways.google.authUrl(state, nonce));
    },
  );
};
