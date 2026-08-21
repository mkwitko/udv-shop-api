import type { FastifyPluginAsync } from "fastify";
import { createCategoryRoute } from "./create-category/create-category.controller.js";
import { deleteCategoryRoute } from "./delete-category/delete-category.controller.js";
import { listCategoriesRoute } from "./list-categories/list-categories.controller.js";
import { reorderCategoriesRoute } from "./reorder-categories/reorder-categories.controller.js";
import { updateCategoryRoute } from "./update-category/update-category.controller.js";

export const productCategoriesRoutes: FastifyPluginAsync = async (app) => {
  await app.register(listCategoriesRoute);
  await app.register(createCategoryRoute);
  // `/reorder` antes de `/:id` para a rota fixa não ser engolida pelo parâmetro
  await app.register(reorderCategoriesRoute);
  await app.register(updateCategoryRoute);
  await app.register(deleteCategoryRoute);
};
