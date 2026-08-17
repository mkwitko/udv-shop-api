import type { FastifyPluginAsync } from "fastify";
import { db } from "../../../../infra/db/client.js";
import { UnauthorizedError } from "../../../../shared/errors.js";
import { createAuthRepository } from "../auth.repository.js";
import { toPublicUser } from "../auth.types.js";
import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from "../cookies.js";
import { AuthResponse } from "../register/register.schema.js";
import { createTokensService, hashToken } from "../tokens.service.js";

export const refreshRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/auth/refresh",
    {
      config: { public: true, rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: { operationId: "refresh", tags: ["auth"], response: { 200: AuthResponse } },
    },
    async (req, reply) => {
      const raw = req.cookies[REFRESH_COOKIE];
      if (!raw) throw new UnauthorizedError("missing_refresh_cookie");
      const repo = createAuthRepository(db);
      const tokens = createTokensService({ repo });
      try {
        const rotated = await tokens.rotate(raw);
        const row = await repo.findRefreshTokenByHash(hashToken(rotated.refreshToken));
        const user = row ? await repo.findUserById(row.userId) : null;
        if (!user) throw new UnauthorizedError("user_not_found");
        setRefreshCookie(reply, rotated.refreshToken);
        void reply.send({ accessToken: rotated.accessToken, user: toPublicUser(user) });
      } catch (err) {
        clearRefreshCookie(reply);
        throw err;
      }
    },
  );
};
