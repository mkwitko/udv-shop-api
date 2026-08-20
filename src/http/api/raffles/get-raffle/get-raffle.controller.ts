import type { FastifyPluginAsync } from "fastify";
import type { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { resolveCampaignForRaffle } from "../manage.helpers.js";
import { createRafflesRepository, toRaffleResponse } from "../raffles.repository.js";
import { RaffleResponse, RaffleSequenceParams } from "../raffles.schema.js";

export const getRaffleRoute: FastifyPluginAsync = async (app) => {
  const repo = createRafflesRepository(db);
  app.get(
    "/stores/:slug/campaigns/:campaignSlug/raffles/:sequence",
    {
      config: { public: true },
      schema: {
        operationId: "getRaffle",
        tags: ["raffles"],
        params: RaffleSequenceParams,
        response: { 200: RaffleResponse },
      },
    },
    async (req) => {
      const { sequence } = req.params as z.infer<typeof RaffleSequenceParams>;
      const { campaign } = await resolveCampaignForRaffle(req, "public");
      const raffle = await repo.findBySequence(campaign.id, sequence);
      if (!raffle) throw new NotFoundError("raffle_not_found");
      const counts = await repo.countEntries(raffle.id);
      return toRaffleResponse(raffle, counts, app.gateways.r2.publicUrl);
    },
  );
};
