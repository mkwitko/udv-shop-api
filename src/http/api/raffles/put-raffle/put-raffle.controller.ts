import type { FastifyPluginAsync } from "fastify";
import type { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ConflictError, NotFoundError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveCampaignForRaffle } from "../manage.helpers.js";
import { createRafflesRepository, toRaffleResponse } from "../raffles.repository.js";
import {
  assertUniquePrizePositions,
  PutRaffleBody,
  RaffleResponse,
  RaffleSequenceParams,
} from "../raffles.schema.js";

/**
 * Reconfigura um sorteio existente. Não cria: sorteio novo é POST em `/raffles`, porque a
 * sequência é atribuída pelo servidor e um PUT em sequência inexistente seria a pessoa
 * escolhendo a numeração.
 */
export const putRaffleRoute: FastifyPluginAsync = async (app) => {
  const repo = createRafflesRepository(db);
  app.put(
    "/stores/:slug/campaigns/:campaignSlug/raffles/:sequence",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "putRaffle",
        tags: ["raffles"],
        params: RaffleSequenceParams,
        body: PutRaffleBody,
        response: { 200: RaffleResponse },
      },
    },
    async (req) => {
      const { sequence } = req.params as z.infer<typeof RaffleSequenceParams>;
      const { store, campaign } = await resolveCampaignForRaffle(req, "admin");
      requireWritableStore(req, store);
      const body = req.body as PutRaffleBody;
      assertUniquePrizePositions(body.prizes);
      const current = await repo.findBySequence(campaign.id, sequence);
      if (!current) throw new NotFoundError("raffle_not_found");
      if (current.status !== "open") throw new ConflictError("raffle_not_open");
      const counts = await repo.countEntries(current.id);
      // Mudar a regra depois que já existe número concedido muda o jogo no meio —
      // ver D8. Prêmios, título e janela continuam editáveis.
      if (counts.entries > 0 && current.centsPerNumber !== body.centsPerNumber) {
        throw new ConflictError("raffle_has_entries");
      }
      const raffle = await repo.updateConfig(current.id, {
        title: body.title,
        centsPerNumber: body.centsPerNumber,
        startsAt: body.startsAt ? new Date(body.startsAt) : current.startsAt,
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        drawAt: body.drawAt ? new Date(body.drawAt) : null,
        prizes: body.prizes,
      });
      const after = await repo.countEntries(raffle.id);
      return toRaffleResponse(raffle, after, app.gateways.r2.publicUrl);
    },
  );
};
