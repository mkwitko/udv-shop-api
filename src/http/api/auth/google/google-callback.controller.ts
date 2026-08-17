import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../../../../config/env.js";
import { db } from "../../../../infra/db/client.js";
import { createAuthRepository } from "../auth.repository.js";
import { setRefreshCookie } from "../cookies.js";
import { createTokensService } from "../tokens.service.js";
import { createGoogleAuthService } from "./google.service.js";

const CallbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
});
type CallbackQuery = z.infer<typeof CallbackQuery>;

export const googleCallbackRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/auth/google/callback",
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { operationId: "googleCallback", tags: ["auth"], querystring: CallbackQuery },
    },
    async (req, reply) => {
      const fail = () => reply.redirect(`${env.WEB_ORIGIN}/entrar?oauth=erro`);
      const { code, state } = req.query as CallbackQuery;

      const stateCookie = req.cookies.udv_oauth_state
        ? req.unsignCookie(req.cookies.udv_oauth_state)
        : null;
      const nonceCookie = req.cookies.udv_oauth_nonce
        ? req.unsignCookie(req.cookies.udv_oauth_nonce)
        : null;
      void reply.clearCookie("udv_oauth_state", { path: "/auth" });
      void reply.clearCookie("udv_oauth_nonce", { path: "/auth" });

      if (
        !code ||
        !state ||
        !stateCookie?.valid ||
        stateCookie.value !== state ||
        !nonceCookie?.valid
      ) {
        return fail();
      }

      try {
        const repo = createAuthRepository(db);
        const service = createGoogleAuthService({
          repo,
          tokens: createTokensService({ repo }),
          google: app.gateways.google,
        });
        const { refreshToken } = await service({ code, nonce: nonceCookie.value });
        setRefreshCookie(reply, refreshToken);
        return reply.redirect(`${env.WEB_ORIGIN}/entrar?oauth=ok`);
      } catch (err) {
        req.log.warn({ err }, "google oauth callback failed");
        return fail();
      }
    },
  );
};
