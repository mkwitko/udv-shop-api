import type { FastifyPluginAsync } from "fastify";
import { cancelInterestRoute } from "./cancel-interest/cancel-interest.controller.js";
import { createInterestRoute } from "./create-interest/create-interest.controller.js";
import { interestDemandRoute } from "./interest-demand/interest-demand.controller.js";
import { listMyInterestsRoute } from "./list-my-interests/list-my-interests.controller.js";
import { listStoreInterestsRoute } from "./list-store-interests/list-store-interests.controller.js";

export const interestsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createInterestRoute);
  await app.register(listMyInterestsRoute);
  await app.register(cancelInterestRoute);
  await app.register(listStoreInterestsRoute);
  await app.register(interestDemandRoute);
};
