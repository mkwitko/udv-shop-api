import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

export const getHealthRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/health",
    {
      config: { public: true, rateLimit: false },
      schema: {
        operationId: "getHealth",
        tags: ["health"],
        response: { 200: z.object({ status: z.literal("ok") }) },
      },
    },
    async () => ({ status: "ok" as const }),
  );
};
