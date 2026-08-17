import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { createAuthRepository } from "../auth.repository.js";
import { VerifyEmailBody } from "./verify-email.schema.js";
import { createVerifyEmailService } from "./verify-email.service.js";

export const verifyEmailRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/auth/verify-email",
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        operationId: "verifyEmail",
        tags: ["auth"],
        body: VerifyEmailBody,
        response: { 204: z.null().describe("No Content") },
      },
    },
    async (req, reply) => {
      const service = createVerifyEmailService({ repo: createAuthRepository(db) });
      await service(req.body as VerifyEmailBody);
      void reply.code(204).send();
    },
  );
};
