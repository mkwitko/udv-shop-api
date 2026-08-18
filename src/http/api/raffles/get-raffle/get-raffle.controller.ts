import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { optionalUser } from "../../../hooks/optional-user.js";
import { createCampaignsRepository } from "../../campaigns/campaigns.repository.js";
import { assertStoreReadable, isStoreMember } from "../../stores/store-visibility.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { createRafflesRepository, toRaffleResponse } from "../raffles.repository.js";
import { RaffleResponse } from "../raffles.schema.js";

const Params = z.object({ slug: z.string(), campaignSlug: z.string() });

export const getRaffleRoute: FastifyPluginAsync = async (app) => {
  const repo = createRafflesRepository(db);
  app.get(
    "/stores/:slug/campaigns/:campaignSlug/raffle",
    {
      config: { public: true },
      schema: {
        operationId: "getRaffle",
        tags: ["raffles"],
        params: Params,
        response: { 200: RaffleResponse },
      },
    },
    async (req) => {
      const { slug, campaignSlug } = req.params as z.infer<typeof Params>;
      const store = await createStoresRepository(db).findBySlug(slug);
      const user = await optionalUser(req);
      assertStoreReadable(store, user);
      const member = isStoreMember(user, store.id);
      const campaign = await createCampaignsRepository(db).findBySlug(store.id, campaignSlug);
      // Rascunho é 404 para quem não é da loja — não vaza nem a existência.
      if (!campaign || (campaign.status === "draft" && !member)) {
        throw new NotFoundError("campaign_not_found");
      }
      const raffle = await repo.findByCampaignId(campaign.id);
      if (!raffle) throw new NotFoundError("raffle_not_found");
      const counts = await repo.countEntries(raffle.id);
      return toRaffleResponse(raffle, counts);
    },
  );
};
