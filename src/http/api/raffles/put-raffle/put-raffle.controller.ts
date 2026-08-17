import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ConflictError, NotFoundError, ValidationError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { createCampaignsRepository } from "../../campaigns/campaigns.repository.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { createRafflesRepository, toRaffleResponse } from "../raffles.repository.js";
import { PutRaffleBody, RaffleResponse } from "../raffles.schema.js";

const Params = z.object({ slug: z.string(), campaignSlug: z.string() });

export const putRaffleRoute: FastifyPluginAsync = async (app) => {
  const repo = createRafflesRepository(db);
  app.put(
    "/stores/:slug/campaigns/:campaignSlug/raffle",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "putRaffle",
        tags: ["raffles"],
        params: Params,
        body: PutRaffleBody,
        response: { 200: RaffleResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "admin");
      requireWritableStore(req, store);
      const { campaignSlug } = req.params as { campaignSlug: string };
      const campaign = await createCampaignsRepository(db).findBySlug(store.id, campaignSlug);
      if (!campaign) throw new NotFoundError("campaign_not_found");
      const body = req.body as PutRaffleBody;
      const positions = body.prizes.map((p) => p.position);
      if (new Set(positions).size !== positions.length) {
        throw new ValidationError("duplicate_prize_position");
      }
      const current = await repo.findByCampaignId(campaign.id);
      if (current && current.status !== "open") throw new ConflictError("raffle_not_open");
      if (current) {
        const counts = await repo.countEntries(current.id);
        // Mudar a regra depois que já existe número concedido muda o jogo no meio —
        // ver D8. Prêmios continuam editáveis.
        if (counts.entries > 0 && current.centsPerNumber !== body.centsPerNumber) {
          throw new ConflictError("raffle_has_entries");
        }
      }
      const raffle = await repo.upsertConfig({
        campaignId: campaign.id,
        centsPerNumber: body.centsPerNumber,
        drawAt: body.drawAt ? new Date(body.drawAt) : null,
        prizes: body.prizes,
      });
      const counts = await repo.countEntries(raffle.id);
      return toRaffleResponse(raffle, counts);
    },
  );
};
