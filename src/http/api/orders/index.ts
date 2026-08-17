import type { FastifyPluginAsync } from "fastify";
import { checkoutRoute } from "./checkout/checkout.controller.js";
import { getMyOrderRoute } from "./get-my-order/get-my-order.controller.js";
import { listMyOrdersRoute } from "./list-my-orders/list-my-orders.controller.js";

export const ordersRoutes: FastifyPluginAsync = async (app) => {
  await app.register(checkoutRoute);
  await app.register(listMyOrdersRoute);
  await app.register(getMyOrderRoute);
};
