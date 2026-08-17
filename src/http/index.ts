import type { FastifyPluginAsync } from "fastify";
import { getHealthRoute } from "./api/health/get-health/get-health.controller.js";

export const httpRoutes: FastifyPluginAsync = async (app) => {
  await app.register(getHealthRoute);
};
