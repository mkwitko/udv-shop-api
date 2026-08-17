import type { FastifyPluginAsync } from "fastify";
import { createStoreRoute } from "./create-store/create-store.controller.js";
import { getStoreRoute } from "./get-store/get-store.controller.js";
import { listStoresRoute } from "./list-stores/list-stores.controller.js";

export const storesRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createStoreRoute);
  await app.register(listStoresRoute);
  await app.register(getStoreRoute);
};
