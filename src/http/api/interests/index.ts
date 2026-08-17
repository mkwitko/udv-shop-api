import type { FastifyPluginAsync } from "fastify";
import { createInterestRoute } from "./create-interest/create-interest.controller.js";

export const interestsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createInterestRoute);
};
