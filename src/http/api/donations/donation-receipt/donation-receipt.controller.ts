import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { strictLimit } from "../../../plugins/rate-limit.js";
import { createDonationsRepository } from "../donations.repository.js";
import { DonationReceiptResponse } from "../donations.schema.js";

const Params = z.object({ id: z.string().uuid() });
const Query = z.object({ token: z.string().uuid() });

export const donationReceiptRoute: FastifyPluginAsync = async (app) => {
  const donations = createDonationsRepository(db);
  app.get(
    "/donations/:id/receipt",
    {
      // Público porque quem doou sem conta não tem sessão para apresentar, e o Pix é
      // assíncrono: é por aqui que a tela de obrigado descobre que o pagamento caiu e mostra
      // os números da sorte. O teto é alto porque essa tela pergunta a cada 4 segundos, em
      // cada aba aberta.
      config: { public: true, rateLimit: strictLimit(120) },
      schema: {
        operationId: "getDonationReceipt",
        tags: ["donations"],
        params: Params,
        querystring: Query,
        response: { 200: DonationReceiptResponse },
      },
    },
    async (req) => {
      const { id } = req.params as z.infer<typeof Params>;
      const { token } = req.query as z.infer<typeof Query>;
      const donation = await donations.findByPublicToken(id, token);
      // 404 e não 403: um token errado não confirma que a doação existe.
      if (!donation) throw new NotFoundError("donation_not_found");
      return {
        id: donation.id,
        status: donation.status,
        type: donation.type,
        amountCents: donation.amountCents,
        currency: donation.currency,
        store: { slug: donation.store.slug, name: donation.store.name },
        campaign: donation.campaign
          ? { slug: donation.campaign.slug, title: donation.campaign.title }
          : null,
        raffleNumbers: donation.entries.map((e) => e.number),
        createdAt: donation.createdAt.toISOString(),
      };
    },
  );
};
