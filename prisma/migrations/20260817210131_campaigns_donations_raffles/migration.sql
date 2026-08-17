/*
  Warnings:

  - A unique constraint covering the columns `[donation_id]` on the table `payments` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'active', 'paused', 'finished');

-- CreateEnum
CREATE TYPE "CampaignAcceptedTypes" AS ENUM ('one_time', 'monthly', 'both');

-- CreateEnum
CREATE TYPE "DonationType" AS ENUM ('one_time', 'monthly');

-- CreateEnum
CREATE TYPE "DonationStatus" AS ENUM ('pending_payment', 'paid', 'failed', 'cancelled', 'refunded');

-- CreateEnum
CREATE TYPE "RaffleStatus" AS ENUM ('open', 'drawn', 'cancelled');

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "donation_id" UUID;

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "story" TEXT,
    "cover_image" TEXT,
    "goal_cents" INTEGER,
    "accepted_types" "CampaignAcceptedTypes" NOT NULL DEFAULT 'both',
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "donations" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "campaign_id" UUID,
    "user_id" UUID NOT NULL,
    "type" "DonationType" NOT NULL DEFAULT 'one_time',
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "status" "DonationStatus" NOT NULL DEFAULT 'pending_payment',
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "message" TEXT,
    "subscription_ref" TEXT,
    "provider_invoice_id" TEXT,
    "subscription_cancelled_at" TIMESTAMP(3),
    "raffle_granted" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "donations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raffles" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "cents_per_number" INTEGER NOT NULL,
    "draw_at" TIMESTAMP(3),
    "status" "RaffleStatus" NOT NULL DEFAULT 'open',
    "seed" TEXT,
    "algorithm" TEXT NOT NULL DEFAULT 'sha256-counter-v1',
    "drawn_at" TIMESTAMP(3),
    "next_number" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "raffles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raffle_prizes" (
    "id" UUID NOT NULL,
    "raffle_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "winner_entry_id" UUID,

    CONSTRAINT "raffle_prizes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raffle_entries" (
    "id" UUID NOT NULL,
    "raffle_id" UUID NOT NULL,
    "donation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raffle_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_store_id_status_created_at_id_idx" ON "campaigns"("store_id", "status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "campaigns_status_created_at_id_idx" ON "campaigns"("status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_store_id_slug_key" ON "campaigns"("store_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "donations_provider_invoice_id_key" ON "donations"("provider_invoice_id");

-- CreateIndex
CREATE INDEX "donations_campaign_id_status_created_at_id_idx" ON "donations"("campaign_id", "status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "donations_store_id_status_created_at_id_idx" ON "donations"("store_id", "status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "donations_user_id_created_at_id_idx" ON "donations"("user_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "donations_status_expires_at_idx" ON "donations"("status", "expires_at");

-- CreateIndex
CREATE INDEX "donations_subscription_ref_idx" ON "donations"("subscription_ref");

-- CreateIndex
CREATE UNIQUE INDEX "raffles_campaign_id_key" ON "raffles"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "raffle_prizes_winner_entry_id_key" ON "raffle_prizes"("winner_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "raffle_prizes_raffle_id_position_key" ON "raffle_prizes"("raffle_id", "position");

-- CreateIndex
CREATE INDEX "raffle_entries_raffle_id_donation_id_idx" ON "raffle_entries"("raffle_id", "donation_id");

-- CreateIndex
CREATE INDEX "raffle_entries_user_id_idx" ON "raffle_entries"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "raffle_entries_raffle_id_number_key" ON "raffle_entries"("raffle_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "payments_donation_id_key" ON "payments"("donation_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "donations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donations" ADD CONSTRAINT "donations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donations" ADD CONSTRAINT "donations_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donations" ADD CONSTRAINT "donations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffles" ADD CONSTRAINT "raffles_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle_prizes" ADD CONSTRAINT "raffle_prizes_raffle_id_fkey" FOREIGN KEY ("raffle_id") REFERENCES "raffles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle_prizes" ADD CONSTRAINT "raffle_prizes_winner_entry_id_fkey" FOREIGN KEY ("winner_entry_id") REFERENCES "raffle_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle_entries" ADD CONSTRAINT "raffle_entries_raffle_id_fkey" FOREIGN KEY ("raffle_id") REFERENCES "raffles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle_entries" ADD CONSTRAINT "raffle_entries_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "donations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle_entries" ADD CONSTRAINT "raffle_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
