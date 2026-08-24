import type { FastifyPluginAsync } from "fastify";
import { createAccountLinkRoute } from "./create-account-link/create-account-link.controller.js";
import { createAccountSessionRoute } from "./create-account-session/create-account-session.controller.js";
import { createDashboardLinkRoute } from "./create-dashboard-link/create-dashboard-link.controller.js";
import { getConnectStatusRoute } from "./get-connect-status/get-connect-status.controller.js";
import { getWooviBalanceRoute } from "./get-woovi-balance/get-woovi-balance.controller.js";
import { putWooviConnectRoute } from "./put-woovi-connect/put-woovi-connect.controller.js";
import { verifyWooviPixKeyRoute } from "./verify-woovi-pix-key/verify-woovi-pix-key.controller.js";
import { withdrawWooviRoute } from "./withdraw-woovi/withdraw-woovi.controller.js";

export const connectRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createAccountLinkRoute);
  await app.register(createAccountSessionRoute);
  await app.register(createDashboardLinkRoute);
  await app.register(getConnectStatusRoute);
  await app.register(putWooviConnectRoute);
  await app.register(getWooviBalanceRoute);
  await app.register(verifyWooviPixKeyRoute);
  await app.register(withdrawWooviRoute);
};
