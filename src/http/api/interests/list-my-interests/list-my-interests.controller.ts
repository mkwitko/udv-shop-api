import type { FastifyPluginAsync } from "fastify";
import type { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { requireUser } from "../../../hooks/auth.js";
import { createInterestsRepository, toInterestResponse } from "../interests.repository.js";
import { InterestsListQuery, InterestsPageResponse } from "../interests.schema.js";

export const listMyInterestsRoute: FastifyPluginAsync = async (app) => {
  const repo = createInterestsRepository(db);
  app.get(
    "/interests",
    {
      config: { permissions: { any: ["customer"] } },
      schema: {
        operationId: "listMyInterests",
        tags: ["interests"],
        querystring: InterestsListQuery,
        response: { 200: InterestsPageResponse },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const { limit, cursor, status } = req.query as z.infer<typeof InterestsListQuery>;
      const page = await repo.listMineCursor({
        userId: user.sub,
        status: status ?? null,
        limit,
        cursor: cursor ?? null,
      });
      return { items: page.items.map(toInterestResponse), nextCursor: page.nextCursor };
    },
  );
};
