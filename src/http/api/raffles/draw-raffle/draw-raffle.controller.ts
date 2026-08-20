import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveCampaignForRaffle } from "../manage.helpers.js";
import { createRafflesRepository, toRaffleResponse } from "../raffles.repository.js";
import { DrawRaffleResponse, RaffleSequenceParams } from "../raffles.schema.js";

export const drawRaffleRoute: FastifyPluginAsync = async (app) => {
  const repo = createRafflesRepository(db);
  app.post(
    "/stores/:slug/campaigns/:campaignSlug/raffles/:sequence/draw",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "drawRaffle",
        tags: ["raffles"],
        params: RaffleSequenceParams,
        response: { 202: DrawRaffleResponse },
      },
    },
    async (req, reply) => {
      const { sequence } = req.params as z.infer<typeof RaffleSequenceParams>;
      const { store, campaign } = await resolveCampaignForRaffle(req, "admin");
      requireWritableStore(req, store);
      const current = await repo.findBySequence(campaign.id, sequence);
      if (!current) throw new NotFoundError("raffle_not_found");
      // Seed nasce agora, não na configuração: publicá-la antes permitiria calcular
      // quanto doar para cair no número vencedor (ver D7).
      const seed = randomBytes(16).toString("hex");
      const raffle = await repo.draw(current.id, seed);
      const counts = await repo.countEntries(raffle.id);
      const response = toRaffleResponse(raffle, counts, app.gateways.r2.publicUrl);
      void reply.code(202).send({
        seed: raffle.seed as string,
        algorithm: raffle.algorithm,
        drawnAt: (raffle.drawnAt as Date).toISOString(),
        prizes: response.prizes,
      });
    },
  );
};
