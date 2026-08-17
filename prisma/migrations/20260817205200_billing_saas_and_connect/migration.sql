-- CreateEnum
CREATE TYPE "StoreSubscriptionStatus" AS ENUM ('incomplete', 'trialing', 'active', 'past_due', 'canceled');

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "stripe_charges_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripe_details_submitted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripe_payouts_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "woovi_subaccount_id" TEXT;

-- CreateTable
CREATE TABLE "store_subscriptions" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "stripe_customer_id" TEXT NOT NULL,
    "stripe_subscription_id" TEXT,
    "price_id" TEXT,
    "status" "StoreSubscriptionStatus" NOT NULL DEFAULT 'incomplete',
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "store_subscriptions_store_id_key" ON "store_subscriptions"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_subscriptions_stripe_subscription_id_key" ON "store_subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "stores_stripe_account_id_key" ON "stores"("stripe_account_id");

-- AddForeignKey
ALTER TABLE "store_subscriptions" ADD CONSTRAINT "store_subscriptions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

