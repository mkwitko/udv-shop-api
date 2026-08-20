import type { FastifyPluginAsync } from "fastify";
import type { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveCampaignForRaffle } from "../manage.helpers.js";
import { createRafflesRepository, toRaffleResponse } from "../raffles.repository.js";
import { RaffleResponse, RaffleSequenceParams, UpdateRaffleStatusBody } from "../raffles.schema.js";

/**
 * Cancela ou reabre um sorteio. Cancelar devolve os números para quem doou; reabrir
 * revalida a janela (outro sorteio pode ter ocupado o período) e reconcede os números.
 * Sorteio realizado não transita — ver `setStatus`.
 */
export const updateRaffleStatusRoute: FastifyPluginAsync = async (app) => {
  const repo = createRafflesRepository(db);
  app.patch(
    "/stores/:slug/campaigns/:campaignSlug/raffles/:sequence/status",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "updateRaffleStatus",
        tags: ["raffles"],
        params: RaffleSequenceParams,
        body: UpdateRaffleStatusBody,
        response: { 200: RaffleResponse },
      },
    },
    async (req) => {
      const { sequence } = req.params as z.infer<typeof RaffleSequenceParams>;
      const { store, campaign } = await resolveCampaignForRaffle(req, "admin");
      requireWritableStore(req, store);
      const current = await repo.findBySequence(campaign.id, sequence);
      if (!current) throw new NotFoundError("raffle_not_found");
      const { status } = req.body as UpdateRaffleStatusBody;
      const raffle = await repo.setStatus(current.id, status);
      const counts = await repo.countEntries(raffle.id);
      return toRaffleResponse(raffle, counts, app.gateways.r2.publicUrl);
    },
  );
};
