import type { FastifyPluginAsync } from "fastify";
import { cancelSubscriptionRoute } from "./cancel-subscription/cancel-subscription.controller.js";
import { createDonationRoute } from "./create-donation/create-donation.controller.js";

export const donationsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createDonationRoute);
  await app.register(cancelSubscriptionRoute);
};
