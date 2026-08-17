import type { FastifyPluginAsync } from "fastify";
import { cancelOrderRoute } from "./cancel-order/cancel-order.controller.js";
import { checkoutRoute } from "./checkout/checkout.controller.js";
import { getMyOrderRoute } from "./get-my-order/get-my-order.controller.js";
import { listMyOrdersRoute } from "./list-my-orders/list-my-orders.controller.js";
import { listStoreOrdersRoute } from "./list-store-orders/list-store-orders.controller.js";
import { refundOrderRoute } from "./refund-order/refund-order.controller.js";
import { updateOrderStatusRoute } from "./update-order-status/update-order-status.controller.js";

export const ordersRoutes: FastifyPluginAsync = async (app) => {
  await app.register(checkoutRoute);
  await app.register(listMyOrdersRoute);
  await app.register(getMyOrderRoute);
  await app.register(listStoreOrdersRoute);
  await app.register(updateOrderStatusRoute);
  await app.register(cancelOrderRoute);
  await app.register(refundOrderRoute);
};
