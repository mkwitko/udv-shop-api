import type { FastifyPluginAsync } from "fastify";
import { adminListStoresRoute } from "./admin-list-stores/admin-list-stores.controller.js";
import { createStoreRoute } from "./create-store/create-store.controller.js";
import { getStoreRoute } from "./get-store/get-store.controller.js";
import { listMyStoresRoute } from "./list-my-stores/list-my-stores.controller.js";
import { listStoresRoute } from "./list-stores/list-stores.controller.js";
import { updateStoreRoute } from "./update-store/update-store.controller.js";
import { updateStoreStatusRoute } from "./update-store-status/update-store-status.controller.js";

export const storesRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createStoreRoute);
  await app.register(adminListStoresRoute);
  await app.register(listStoresRoute);
  await app.register(listMyStoresRoute);
  await app.register(getStoreRoute);
  await app.register(updateStoreRoute);
  await app.register(updateStoreStatusRoute);
};
