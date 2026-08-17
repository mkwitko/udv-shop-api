import type { FastifyPluginAsync } from "fastify";
import { db } from "../../../../infra/db/client.js";
import { createAuthRepository } from "../auth.repository.js";
import { setRefreshCookie } from "../cookies.js";
import { createTokensService } from "../tokens.service.js";
import { AuthResponse, RegisterBody } from "./register.schema.js";
import { createRegisterService } from "./register.service.js";

export const registerRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/auth/register",
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        operationId: "register",
        tags: ["auth"],
        body: RegisterBody,
        response: { 201: AuthResponse },
      },
    },
    async (req, reply) => {
      const repo = createAuthRepository(db);
      const service = createRegisterService({
        repo,
        tokens: createTokensService({ repo }),
        email: app.gateways.email,
      });
      const { refreshToken, ...result } = await service(req.body as RegisterBody);
      setRefreshCookie(reply, refreshToken);
      void reply.code(201).send(result);
    },
  );
};
