import type { FastifyPluginAsync } from "fastify";
import { getRaffleRoute } from "../raffles/get-raffle/get-raffle.controller.js";
import { putRaffleRoute } from "../raffles/put-raffle/put-raffle.controller.js";
import { createCampaignRoute } from "./create-campaign/create-campaign.controller.js";
import { getCampaignRoute } from "./get-campaign/get-campaign.controller.js";
import { listCampaignsRoute } from "./list-campaigns/list-campaigns.controller.js";
import { updateCampaignRoute } from "./update-campaign/update-campaign.controller.js";
import { updateCampaignStatusRoute } from "./update-campaign-status/update-campaign-status.controller.js";

export const campaignsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createCampaignRoute);
  await app.register(listCampaignsRoute);
  await app.register(getCampaignRoute);
  await app.register(updateCampaignRoute);
  await app.register(updateCampaignStatusRoute);
  // O sorteio mora sob a campanha na URL; registrar aqui evita uma terceira raiz de rotas.
  await app.register(putRaffleRoute);
  await app.register(getRaffleRoute);
};
