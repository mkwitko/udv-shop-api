import type { FastifyPluginAsync } from "fastify";
import { createBillingCheckoutRoute } from "./create-billing-checkout/create-billing-checkout.controller.js";
import { createBillingPortalRoute } from "./create-billing-portal/create-billing-portal.controller.js";
import { getBillingStatusRoute } from "./get-billing-status/get-billing-status.controller.js";

export const billingRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createBillingCheckoutRoute);
  await app.register(createBillingPortalRoute);
  await app.register(getBillingStatusRoute);
};
