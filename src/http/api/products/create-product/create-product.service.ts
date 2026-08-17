import type { Product } from "@prisma/client";
import { ConflictError } from "../../../../shared/errors.js";
import type { ProductsRepository } from "../products.repository.js";
import type { CreateProductBody } from "../products.schema.js";

export function createCreateProductService(deps: { repo: ProductsRepository }) {
  return async (input: CreateProductBody & { storeId: string }): Promise<Product> => {
    const existing = await deps.repo.findBySlug(input.storeId, input.slug);
    if (existing) throw new ConflictError("product_slug_in_use");
    const { storeId, ...data } = input;
    return deps.repo.create(storeId, data);
  };
}
