import type { FastifyPluginAsync } from "fastify";
import { cancelInterestRoute } from "./cancel-interest/cancel-interest.controller.js";
import { createInterestRoute } from "./create-interest/create-interest.controller.js";
import { listMyInterestsRoute } from "./list-my-interests/list-my-interests.controller.js";

export const interestsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createInterestRoute);
  await app.register(listMyInterestsRoute);
  await app.register(cancelInterestRoute);
};
