import type { FastifyPluginAsync } from "fastify";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireUser } from "../../../hooks/auth.js";
import { createAuthRepository } from "../auth.repository.js";
import { toPublicUser } from "../auth.types.js";
import { PublicUserSchema } from "../register/register.schema.js";

export const meRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/auth/me",
    {
      config: { permissions: { any: ["customer"] } },
      schema: { operationId: "getMe", tags: ["auth"], response: { 200: PublicUserSchema } },
    },
    async (req) => {
      const { sub } = requireUser(req);
      const user = await createAuthRepository(db).findUserById(sub);
      if (!user) throw new NotFoundError(`user ${sub} not found`);
      return toPublicUser(user);
    },
  );
};
