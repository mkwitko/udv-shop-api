import type { FastifyPluginAsync } from "fastify";
import { cancelStoreSubscriptionRoute } from "./cancel-store-subscription/cancel-store-subscription.controller.js";
import { cancelSubscriptionRoute } from "./cancel-subscription/cancel-subscription.controller.js";
import { createDonationRoute } from "./create-donation/create-donation.controller.js";
import { donationReceiptRoute } from "./donation-receipt/donation-receipt.controller.js";
import { getMyDonationRoute } from "./get-my-donation/get-my-donation.controller.js";
import { listMyDonationsRoute } from "./list-my-donations/list-my-donations.controller.js";
import { listStoreDonationsRoute } from "./list-store-donations/list-store-donations.controller.js";

export const donationsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createDonationRoute);
  await app.register(cancelSubscriptionRoute);
  await app.register(cancelStoreSubscriptionRoute);
  await app.register(listMyDonationsRoute);
  await app.register(getMyDonationRoute);
  await app.register(donationReceiptRoute);
  await app.register(listStoreDonationsRoute);
};
