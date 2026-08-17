import type { FastifyPluginAsync } from "fastify";
import { getHealthRoute } from "./api/health/get-health/get-health.controller.js";
import { authHook, permissionsHook } from "./hooks/auth.js";

export const httpRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authHook);
  app.addHook("preHandler", permissionsHook);
  await app.register(getHealthRoute);
};
