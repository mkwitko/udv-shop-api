import type { FastifyPluginAsync } from "fastify";
import { checkoutRoute } from "./checkout/checkout.controller.js";

export const ordersRoutes: FastifyPluginAsync = async (app) => {
  await app.register(checkoutRoute);
};
