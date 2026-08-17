import type { FastifyPluginAsync } from "fastify";
import { archiveProductRoute } from "./archive-product/archive-product.controller.js";
import { createProductRoute } from "./create-product/create-product.controller.js";
import { updateProductRoute } from "./update-product/update-product.controller.js";

export const productsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createProductRoute);
  await app.register(updateProductRoute);
  await app.register(archiveProductRoute);
};
