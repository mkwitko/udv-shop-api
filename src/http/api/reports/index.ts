import type { FastifyPluginAsync } from "fastify";
import { exportInterestsRoute } from "./export-interests/export-interests.controller.js";
import { exportOrdersRoute } from "./export-orders/export-orders.controller.js";
import { getStatementRoute } from "./get-statement/get-statement.controller.js";

export const reportsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(getStatementRoute);
  await app.register(exportOrdersRoute);
  await app.register(exportInterestsRoute);
};
