import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ConflictError, NotFoundError } from "../../../../shared/errors.js";
import { requireUser } from "../../../hooks/auth.js";
import { createInterestsRepository, toInterestResponse } from "../interests.repository.js";
import { InterestResponse } from "../interests.schema.js";

export const cancelInterestRoute: FastifyPluginAsync = async (app) => {
  const repo = createInterestsRepository(db);
  app.delete(
    "/interests/:id",
    {
      config: { permissions: { any: ["customer"] } },
      schema: {
        operationId: "cancelInterest",
        tags: ["interests"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: InterestResponse },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const { id } = req.params as { id: string };
      // Escopo por userId na própria query: interesse de outra pessoa é 404, não 403.
      const existing = await repo.findByIdForUser(id, user.sub);
      if (!existing) throw new NotFoundError("interest_not_found");
      const ok = await repo.cancelMine(id, user.sub);
      if (!ok) throw new ConflictError("interest_not_cancellable");
      const fresh = await repo.findByIdForUser(id, user.sub);
      if (!fresh) throw new NotFoundError("interest_not_found");
      return toInterestResponse(fresh);
    },
  );
};
