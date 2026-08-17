import type { FastifyPluginAsync } from "fastify";
import { authRoutes } from "./api/auth/index.js";
import { getHealthRoute } from "./api/health/get-health/get-health.controller.js";
import { interestsRoutes } from "./api/interests/index.js";
import { ordersRoutes } from "./api/orders/index.js";
import { productsRoutes } from "./api/products/index.js";
import { storesRoutes } from "./api/stores/index.js";
import { uploadsRoutes } from "./api/uploads/index.js";
import { webhooksRoutes } from "./api/webhooks/index.js";
import { authHook, permissionsHook } from "./hooks/auth.js";

export const httpRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", authHook);
  app.addHook("onRequest", permissionsHook);
  await app.register(getHealthRoute);
  await app.register(authRoutes);
  await app.register(uploadsRoutes);
  await app.register(storesRoutes);
  await app.register(productsRoutes);
  await app.register(interestsRoutes);
  await app.register(ordersRoutes);
  await app.register(webhooksRoutes);
};
