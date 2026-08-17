import type { Campaign, CampaignStatus, Prisma, PrismaClient } from "@prisma/client";
import {
  afterCursorWhere,
  type CursorPage,
  decodeCursor,
  KEYSET_ORDER_BY,
  toPage,
} from "../../../lib/cursor.js";
import type { CreateCampaignBody, UpdateCampaignBody } from "./campaigns.schema.js";

const CAMPAIGN_INCLUDE = {
  store: { select: { slug: true, name: true } },
} satisfies Prisma.CampaignInclude;

export type CampaignWithStore = Prisma.CampaignGetPayload<{ include: typeof CAMPAIGN_INCLUDE }>;

export type CampaignProgress = { raisedCents: number; donationCount: number };

// Campanha só é pública quando saiu do rascunho; membro da loja vê tudo.
const PUBLIC_STATUSES: CampaignStatus[] = ["active", "paused", "finished"];

export interface CampaignsRepository {
  create(storeId: string, data: CreateCampaignBody): Promise<CampaignWithStore>;
  update(id: string, data: UpdateCampaignBody): Promise<CampaignWithStore>;
  setStatus(id: string, status: CampaignStatus): Promise<CampaignWithStore>;
  findBySlug(storeId: string, slug: string): Promise<CampaignWithStore | null>;
  listByStoreCursor(args: {
    storeId: string;
    limit: number;
    cursor: string | null;
    includeDrafts: boolean;
  }): Promise<CursorPage<CampaignWithStore>>;
  progressFor(campaignIds: string[]): Promise<Map<string, CampaignProgress>>;
}

export function createCampaignsRepository(db: PrismaClient): CampaignsRepository {
  return {
    create: (storeId, data) =>
      db.campaign.create({
        data: {
          storeId,
          slug: data.slug,
          title: data.title,
          story: data.story ?? null,
          coverImage: data.coverImage ?? null,
          goalCents: data.goalCents ?? null,
          acceptedTypes: data.acceptedTypes,
          endsAt: data.endsAt ? new Date(data.endsAt) : null,
        },
        include: CAMPAIGN_INCLUDE,
      }),

    update: (id, data) =>
      db.campaign.update({
        where: { id },
        data: {
          ...(data.title !== undefined && { title: data.title }),
          ...(data.story !== undefined && { story: data.story }),
          ...(data.coverImage !== undefined && { coverImage: data.coverImage }),
          ...(data.goalCents !== undefined && { goalCents: data.goalCents }),
          ...(data.acceptedTypes !== undefined && { acceptedTypes: data.acceptedTypes }),
          ...(data.endsAt !== undefined && { endsAt: data.endsAt ? new Date(data.endsAt) : null }),
        },
        include: CAMPAIGN_INCLUDE,
      }),

    setStatus: (id, status) =>
      db.campaign.update({ where: { id }, data: { status }, include: CAMPAIGN_INCLUDE }),

    findBySlug: (storeId, slug) =>
      db.campaign.findUnique({
        where: { storeId_slug: { storeId, slug } },
        include: CAMPAIGN_INCLUDE,
      }),

    listByStoreCursor: async ({ storeId, limit, cursor, includeDrafts }) => {
      const after = cursor ? afterCursorWhere(decodeCursor(cursor)) : {};
      const rows = await db.campaign.findMany({
        where: {
          storeId,
          ...(includeDrafts ? {} : { status: { in: PUBLIC_STATUSES } }),
          ...after,
        },
        orderBy: [...KEYSET_ORDER_BY],
        take: limit + 1,
        include: CAMPAIGN_INCLUDE,
      });
      return toPage(
        rows,
        limit,
        (r) => ({ createdAt: r.createdAt, id: r.id }),
        (r) => r,
      );
    },

    progressFor: async (campaignIds) => {
      const result = new Map<string, CampaignProgress>();
      if (campaignIds.length === 0) return result;
      // Calculado, nunca denormalizado (ver D2): um contador em Campaign divergiria no
      // primeiro estorno e ninguém perceberia.
      const grouped = await db.donation.groupBy({
        by: ["campaignId"],
        where: { campaignId: { in: campaignIds }, status: "paid" },
        _sum: { amountCents: true },
        _count: { _all: true },
      });
      for (const row of grouped) {
        if (!row.campaignId) continue;
        result.set(row.campaignId, {
          raisedCents: row._sum.amountCents ?? 0,
          donationCount: row._count._all,
        });
      }
      return result;
    },
  };
}

export function toCampaignResponse(
  campaign: CampaignWithStore,
  progress: CampaignProgress | undefined,
  publicUrl: (key: string) => string,
) {
  return {
    id: campaign.id,
    store: { slug: campaign.store.slug, name: campaign.store.name },
    slug: campaign.slug,
    title: campaign.title,
    story: campaign.story,
    coverImage: campaign.coverImage,
    coverImageUrl: campaign.coverImage ? publicUrl(campaign.coverImage) : null,
    goalCents: campaign.goalCents,
    raisedCents: progress?.raisedCents ?? 0,
    donationCount: progress?.donationCount ?? 0,
    acceptedTypes: campaign.acceptedTypes,
    status: campaign.status,
    endsAt: campaign.endsAt?.toISOString() ?? null,
    createdAt: campaign.createdAt.toISOString(),
  };
}

export function isCampaignOpenForDonation(campaign: Pick<Campaign, "status" | "endsAt">): boolean {
  if (campaign.status !== "active") return false;
  return !campaign.endsAt || campaign.endsAt.getTime() > Date.now();
}
