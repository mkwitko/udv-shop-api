import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireUser } from "../../../hooks/auth.js";
import { createDonationsRepository, toDonationResponse } from "../donations.repository.js";
import { DonationResponse } from "../donations.schema.js";

const Params = z.object({ id: z.string().uuid() });

export const getMyDonationRoute: FastifyPluginAsync = async (app) => {
  const repo = createDonationsRepository(db);
  app.get(
    "/donations/:id",
    {
      config: { permissions: { any: ["customer"] } },
      schema: {
        operationId: "getMyDonation",
        tags: ["donations"],
        params: Params,
        response: { 200: DonationResponse },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const { id } = req.params as z.infer<typeof Params>;
      const donation = await repo.findByIdForUser(id, user.sub);
      if (!donation) throw new NotFoundError("donation_not_found");
      return toDonationResponse(donation);
    },
  );
};
