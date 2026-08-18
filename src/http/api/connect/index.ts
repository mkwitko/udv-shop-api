import type { FastifyPluginAsync } from "fastify";
import { createAccountLinkRoute } from "./create-account-link/create-account-link.controller.js";
import { getConnectStatusRoute } from "./get-connect-status/get-connect-status.controller.js";
import { putWooviConnectRoute } from "./put-woovi-connect/put-woovi-connect.controller.js";

export const connectRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createAccountLinkRoute);
  await app.register(getConnectStatusRoute);
  await app.register(putWooviConnectRoute);
};
