import type { FastifyRequest } from "fastify";
import { db } from "../../../infra/db/client.js";
import { NotFoundError } from "../../../shared/errors.js";
import { optionalUser } from "../../hooks/optional-user.js";
import { createCampaignsRepository } from "../campaigns/campaigns.repository.js";
import { resolveStoreForRole } from "../campaigns/manage.helpers.js";
import { assertStoreReadable, isStoreMember } from "../stores/store-visibility.js";
import { createStoresRepository } from "../stores/stores.repository.js";

/**
 * Loja + campanha para as rotas de sorteio. Cinco controllers repetiam esse trecho, e a
 * regra "campanha rascunho é 404 para quem é de fora" tem de valer nos cinco — não vaza
 * nem a existência.
 */
export async function resolveCampaignForRaffle(req: FastifyRequest, access: "admin" | "public") {
  const { slug, campaignSlug } = req.params as { slug: string; campaignSlug: string };
  if (access === "admin") {
    const store = await resolveStoreForRole(req, "admin");
    const campaign = await createCampaignsRepository(db).findBySlug(store.id, campaignSlug);
    if (!campaign) throw new NotFoundError("campaign_not_found");
    return { store, campaign };
  }
  const store = await createStoresRepository(db).findBySlug(slug);
  const user = await optionalUser(req);
  assertStoreReadable(store, user);
  const member = isStoreMember(user, store.id);
  const campaign = await createCampaignsRepository(db).findBySlug(store.id, campaignSlug);
  if (!campaign || (campaign.status === "draft" && !member)) {
    throw new NotFoundError("campaign_not_found");
  }
  return { store, campaign };
}
