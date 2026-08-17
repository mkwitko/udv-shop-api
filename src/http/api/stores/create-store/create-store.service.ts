import type { Store } from "@prisma/client";
import { ConflictError } from "../../../../shared/errors.js";
import type { StoresRepository } from "../stores.repository.js";
import type { CreateStoreBody } from "../stores.schema.js";

export function createCreateStoreService(deps: { repo: StoresRepository }) {
  return async (input: CreateStoreBody & { userId: string }): Promise<Store> => {
    const existing = await deps.repo.findBySlug(input.slug);
    if (existing) throw new ConflictError("slug_in_use");
    return deps.repo.createWithOwner(
      { slug: input.slug, name: input.name, description: input.description ?? null },
      input.userId,
    );
  };
}
