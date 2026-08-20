import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { resolveCampaignForRaffle } from "../manage.helpers.js";
import { createRafflesRepository, toRaffleResponse } from "../raffles.repository.js";
import { RafflesListResponse } from "../raffles.schema.js";

const Params = z.object({ slug: z.string(), campaignSlug: z.string() });

/** Sorteios da campanha, por sequência. Sem paginação: são poucos por campanha. */
export const listRafflesRoute: FastifyPluginAsync = async (app) => {
  const repo = createRafflesRepository(db);
  app.get(
    "/stores/:slug/campaigns/:campaignSlug/raffles",
    {
      config: { public: true },
      schema: {
        operationId: "listRaffles",
        tags: ["raffles"],
        params: Params,
        response: { 200: RafflesListResponse },
      },
    },
    async (req) => {
      const { campaign } = await resolveCampaignForRaffle(req, "public");
      const raffles = await repo.listByCampaignId(campaign.id);
      const items = await Promise.all(
        raffles.map(async (raffle) =>
          toRaffleResponse(raffle, await repo.countEntries(raffle.id), app.gateways.r2.publicUrl),
        ),
      );
      return { items };
    },
  );
};
