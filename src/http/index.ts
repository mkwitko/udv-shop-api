import type { FastifyPluginAsync } from "fastify";
import { authRoutes } from "./api/auth/index.js";
import { getHealthRoute } from "./api/health/get-health/get-health.controller.js";
import { storesRoutes } from "./api/stores/index.js";
import { uploadsRoutes } from "./api/uploads/index.js";
import { authHook, permissionsHook } from "./hooks/auth.js";

export const httpRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authHook);
  app.addHook("preHandler", permissionsHook);
  await app.register(getHealthRoute);
  await app.register(authRoutes);
  await app.register(uploadsRoutes);
  await app.register(storesRoutes);
};
