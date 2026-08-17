import type { FastifyPluginAsync } from "fastify";
import type { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { requireUser } from "../../../hooks/auth.js";
import { createDonationsRepository, toDonationResponse } from "../donations.repository.js";
import { DonationsListQuery, DonationsPageResponse } from "../donations.schema.js";

export const listMyDonationsRoute: FastifyPluginAsync = async (app) => {
  const repo = createDonationsRepository(db);
  app.get(
    "/donations",
    {
      config: { permissions: { any: ["customer"] } },
      schema: {
        operationId: "listMyDonations",
        tags: ["donations"],
        querystring: DonationsListQuery,
        response: { 200: DonationsPageResponse },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const { limit, cursor, status } = req.query as z.infer<typeof DonationsListQuery>;
      const page = await repo.listMineCursor({
        userId: user.sub,
        status: status ?? null,
        limit,
        cursor: cursor ?? null,
      });
      return { items: page.items.map(toDonationResponse), nextCursor: page.nextCursor };
    },
  );
};
