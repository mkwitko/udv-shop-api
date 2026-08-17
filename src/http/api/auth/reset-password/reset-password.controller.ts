import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { createAuthRepository } from "../auth.repository.js";
import { createTokensService } from "../tokens.service.js";
import { ResetPasswordBody } from "./reset-password.schema.js";
import { createResetPasswordService } from "./reset-password.service.js";

export const resetPasswordRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/auth/reset-password",
    {
      config: { public: true, rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        operationId: "resetPassword",
        tags: ["auth"],
        body: ResetPasswordBody,
        response: { 204: z.null().describe("No Content") },
      },
    },
    async (req, reply) => {
      const repo = createAuthRepository(db);
      const service = createResetPasswordService({ repo, tokens: createTokensService({ repo }) });
      await service(req.body as ResetPasswordBody);
      void reply.code(204).send();
    },
  );
};
