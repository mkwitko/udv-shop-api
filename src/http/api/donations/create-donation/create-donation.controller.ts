import type { FastifyPluginAsync } from "fastify";
import { db } from "../../../../infra/db/client.js";
import { UnauthorizedError } from "../../../../shared/errors.js";
import { requireUser } from "../../../hooks/auth.js";
import { createCampaignsRepository } from "../../campaigns/campaigns.repository.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { createDonationsRepository, toDonationResponse } from "../donations.repository.js";
import { CreateDonationBody, CreateDonationResponse } from "../donations.schema.js";
import { createDonationService } from "./create-donation.service.js";

export const createDonationRoute: FastifyPluginAsync = async (app) => {
  const service = createDonationService({
    donations: createDonationsRepository(db),
    campaigns: createCampaignsRepository(db),
    stores: createStoresRepository(db),
    stripe: app.gateways.stripe,
    woovi: app.gateways.woovi,
  });
  app.post(
    "/donations",
    {
      config: { permissions: { any: ["customer"] } },
      schema: {
        operationId: "createDonation",
        tags: ["donations"],
        body: CreateDonationBody,
        response: { 201: CreateDonationResponse },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      // A assinatura mensal precisa do email para criar o customer na conta conectada.
      const record = await db.user.findUnique({
        where: { id: user.sub },
        select: { email: true },
      });
      if (!record) throw new UnauthorizedError();
      const body = req.body as CreateDonationBody;
      const result = await service({ ...body, userId: user.sub, userEmail: record.email });
      void reply.code(201).send({
        donation: toDonationResponse(result.donation),
        payment: result.payment,
      });
    },
  );
};
