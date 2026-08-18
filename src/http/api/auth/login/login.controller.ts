import type { FastifyPluginAsync } from "fastify";
import { db } from "../../../../infra/db/client.js";
import { strictLimit } from "../../../plugins/rate-limit.js";
import { createAuthRepository } from "../auth.repository.js";
import { setRefreshCookie } from "../cookies.js";
import { createTokensService } from "../tokens.service.js";
import { AuthResponse, LoginBody } from "./login.schema.js";
import { createLoginService } from "./login.service.js";

export const loginRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/auth/login",
    {
      config: { public: true, rateLimit: strictLimit(5) },
      schema: {
        operationId: "login",
        tags: ["auth"],
        body: LoginBody,
        response: { 200: AuthResponse },
      },
    },
    async (req, reply) => {
      const repo = createAuthRepository(db);
      const service = createLoginService({ repo, tokens: createTokensService({ repo }) });
      const { refreshToken, ...result } = await service(req.body as LoginBody);
      setRefreshCookie(reply, refreshToken);
      void reply.send(result);
    },
  );
};
