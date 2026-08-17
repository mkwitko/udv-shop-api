import type { FastifyPluginAsync } from "fastify";
import { createDonationRoute } from "./create-donation/create-donation.controller.js";

export const donationsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createDonationRoute);
};
