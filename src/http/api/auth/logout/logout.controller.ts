import type { FastifyPluginAsync } from "fastify";
import { db } from "../../../../infra/db/client.js";
import { createAuthRepository } from "../auth.repository.js";
import { clearRefreshCookie, REFRESH_COOKIE } from "../cookies.js";
import { createTokensService } from "../tokens.service.js";

export const logoutRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/auth/logout",
    {
      config: { public: true },
      schema: { operationId: "logout", tags: ["auth"] },
    },
    async (req, reply) => {
      const raw = req.cookies[REFRESH_COOKIE];
      if (raw) {
        const repo = createAuthRepository(db);
        await createTokensService({ repo }).revokeFamilyByToken(raw);
      }
      clearRefreshCookie(reply);
      void reply.code(204).send();
    },
  );
};
