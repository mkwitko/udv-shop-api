import type { FastifyPluginAsync } from "fastify";
import type { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { resolveCampaignForRaffle } from "../manage.helpers.js";
import { createRafflesRepository, maskName } from "../raffles.repository.js";
import {
  RaffleEntriesPageResponse,
  RaffleEntriesQuery,
  RaffleSequenceParams,
} from "../raffles.schema.js";

export const listRaffleEntriesRoute: FastifyPluginAsync = async (app) => {
  const repo = createRafflesRepository(db);
  app.get(
    "/stores/:slug/campaigns/:campaignSlug/raffles/:sequence/entries",
    {
      config: { public: true },
      schema: {
        operationId: "listRaffleEntries",
        tags: ["raffles"],
        params: RaffleSequenceParams,
        querystring: RaffleEntriesQuery,
        response: { 200: RaffleEntriesPageResponse },
      },
    },
    async (req) => {
      const { sequence } = req.params as z.infer<typeof RaffleSequenceParams>;
      const { limit, cursor } = req.query as z.infer<typeof RaffleEntriesQuery>;
      const { campaign } = await resolveCampaignForRaffle(req, "public");
      const raffle = await repo.findBySequence(campaign.id, sequence);
      if (!raffle) throw new NotFoundError("raffle_not_found");
      const page = await repo.listEntriesCursor({
        raffleId: raffle.id,
        limit,
        cursor: cursor ?? null,
      });
      return {
        items: page.items.map((e) => ({
          number: e.number,
          participant: maskName(e.user.name, e.donation.anonymous),
        })),
        nextCursor: page.nextCursor,
      };
    },
  );
};
