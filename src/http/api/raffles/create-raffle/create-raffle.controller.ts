import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveCampaignForRaffle } from "../manage.helpers.js";
import { createRafflesRepository, toRaffleResponse } from "../raffles.repository.js";
import { assertUniquePrizePositions, CreateRaffleBody, RaffleResponse } from "../raffles.schema.js";

const Params = z.object({ slug: z.string(), campaignSlug: z.string() });

/**
 * Cria um sorteio da campanha. A sequência é do servidor; a janela não pode se sobrepor à
 * de outro sorteio da mesma campanha (o repositório recusa com 409). Campanha longa tem um
 * sorteio por período, e cada doação concorre ao da janela em que foi paga.
 */
export const createRaffleRoute: FastifyPluginAsync = async (app) => {
  const repo = createRafflesRepository(db);
  app.post(
    "/stores/:slug/campaigns/:campaignSlug/raffles",
    {
      config: { permissions: { any: ["store_owner", "store_admin"] } },
      schema: {
        operationId: "createRaffle",
        tags: ["raffles"],
        params: Params,
        body: CreateRaffleBody,
        response: { 201: RaffleResponse },
      },
    },
    async (req, reply) => {
      const { store, campaign } = await resolveCampaignForRaffle(req, "admin");
      requireWritableStore(req, store);
      const body = req.body as CreateRaffleBody;
      assertUniquePrizePositions(body.prizes);
      const raffle = await repo.create({
        campaignId: campaign.id,
        title: body.title,
        centsPerNumber: body.centsPerNumber,
        startsAt: body.startsAt ? new Date(body.startsAt) : new Date(),
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        drawAt: body.drawAt ? new Date(body.drawAt) : null,
        prizes: body.prizes,
      });
      const counts = await repo.countEntries(raffle.id);
      void reply.code(201).send(toRaffleResponse(raffle, counts, app.gateways.r2.publicUrl));
    },
  );
};
