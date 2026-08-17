-- CreateEnum
CREATE TYPE "ProductInterestStatus" AS ENUM ('open', 'notified', 'converted', 'cancelled');

-- CreateTable
CREATE TABLE "product_interests" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "status" "ProductInterestStatus" NOT NULL DEFAULT 'open',
    "note" TEXT,
    "notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_interests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_interests_product_id_status_idx" ON "product_interests"("product_id", "status");

-- CreateIndex
CREATE INDEX "product_interests_user_id_created_at_id_idx" ON "product_interests"("user_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "product_interests_product_id_user_id_key" ON "product_interests"("product_id", "user_id");

-- AddForeignKey
ALTER TABLE "product_interests" ADD CONSTRAINT "product_interests_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_interests" ADD CONSTRAINT "product_interests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
