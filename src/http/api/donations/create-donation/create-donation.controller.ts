import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../../../../infra/db/client.js";
import { createGuestIdentityRepo, resolveActor } from "../../../../lib/guest-identity.js";
import { UnauthorizedError } from "../../../../shared/errors.js";
import { strictLimit } from "../../../plugins/rate-limit.js";
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
  const guests = createGuestIdentityRepo(db);
  app.post(
    "/donations",
    {
      // Pública para doação avulsa: apoiar um núcleo não pode custar um cadastro. O teto por
      // IP segura abuso sem derrubar a fila de quem doa junto, depois da sessão, no mesmo wifi.
      config: { public: true, optionalAuth: true, rateLimit: strictLimit(20) },
      schema: {
        operationId: "createDonation",
        tags: ["donations"],
        body: CreateDonationBody,
        response: { 201: CreateDonationResponse },
      },
    },
    async (req, reply) => {
      const body = req.body as CreateDonationBody;
      // Mensal continua exigindo conta: a assinatura precisa de e-mail para o customer do
      // Stripe, e quem assina tem que ter onde cancelar sem depender de ninguém.
      if (body.type === "monthly" && !req.user) throw new UnauthorizedError("login_required");
      const actor = await resolveActor(guests, {
        sessionUserId: req.user?.sub,
        contact: body.contact,
      });
      // A assinatura mensal precisa do email para criar o customer na conta conectada.
      const record = await db.user.findUnique({
        where: { id: actor.userId },
        select: { email: true },
      });
      const publicToken = actor.guest ? randomUUID() : null;
      const result = await service({
        ...body,
        userId: actor.userId,
        userEmail: record?.email ?? null,
        publicToken,
      });
      void reply.code(201).send({
        donation: toDonationResponse(result.donation),
        payment: result.payment,
        receiptToken: publicToken,
      });
    },
  );
};
