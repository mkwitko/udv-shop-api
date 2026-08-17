import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { createAuthRepository } from "../auth.repository.js";
import { ForgotPasswordBody } from "./forgot-password.schema.js";
import { createForgotPasswordService } from "./forgot-password.service.js";

export const forgotPasswordRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/auth/forgot-password",
    {
      config: { public: true, rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        operationId: "forgotPassword",
        tags: ["auth"],
        body: ForgotPasswordBody,
        response: { 204: z.null().describe("No Content") },
      },
    },
    async (req, reply) => {
      const service = createForgotPasswordService({
        repo: createAuthRepository(db),
        email: app.gateways.email,
      });
      await service(req.body as ForgotPasswordBody);
      void reply.code(204).send();
    },
  );
};
