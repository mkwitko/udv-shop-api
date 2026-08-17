import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { createCampaignsRepository } from "../../campaigns/campaigns.repository.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { createRafflesRepository, toRaffleResponse } from "../raffles.repository.js";
import { DrawRaffleResponse } from "../raffles.schema.js";

const Params = z.object({ slug: z.string(), campaignSlug: z.string() });

export const drawRaffleRoute: FastifyPluginAsync = async (app) => {
  const repo = createRafflesRepository(db);
  app.post(
    "/stores/:slug/campaigns/:campaignSlug/raffle/draw",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "drawRaffle",
        tags: ["raffles"],
        params: Params,
        response: { 202: DrawRaffleResponse },
      },
    },
    async (req, reply) => {
      const store = await resolveStoreForRole(req, "admin");
      requireWritableStore(req, store);
      const { campaignSlug } = req.params as { campaignSlug: string };
      const campaign = await createCampaignsRepository(db).findBySlug(store.id, campaignSlug);
      if (!campaign) throw new NotFoundError("campaign_not_found");
      const current = await repo.findByCampaignId(campaign.id);
      if (!current) throw new NotFoundError("raffle_not_found");
      // Seed nasce agora, não na configuração: publicá-la antes permitiria calcular
      // quanto doar para cair no número vencedor (ver D7).
      const seed = randomBytes(16).toString("hex");
      const raffle = await repo.draw(current.id, seed);
      const counts = await repo.countEntries(raffle.id);
      const response = toRaffleResponse(raffle, counts);
      void reply.code(202).send({
        seed: raffle.seed as string,
        algorithm: raffle.algorithm,
        drawnAt: (raffle.drawnAt as Date).toISOString(),
        prizes: response.prizes,
      });
    },
  );
};
