-- CreateEnum
CREATE TYPE "PayoutKind" AS ENUM ('fixed_cents', 'percent_bps');

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "payout_cents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "supplier_id" UUID;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "payout_kind" "PayoutKind",
ADD COLUMN     "payout_value" INTEGER,
ADD COLUMN     "supplier_id" UUID;

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "pix_key" TEXT,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_settlements" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "note" TEXT,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppliers_store_id_created_at_id_idx" ON "suppliers"("store_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_store_id_name_key" ON "suppliers"("store_id", "name");

-- CreateIndex
CREATE INDEX "supplier_settlements_supplier_id_paid_at_id_idx" ON "supplier_settlements"("supplier_id", "paid_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "supplier_settlements_store_id_paid_at_id_idx" ON "supplier_settlements"("store_id", "paid_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "order_items_supplier_id_idx" ON "order_items"("supplier_id");

-- CreateIndex
CREATE INDEX "products_supplier_id_idx" ON "products"("supplier_id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_settlements" ADD CONSTRAINT "supplier_settlements_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_settlements" ADD CONSTRAINT "supplier_settlements_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_settlements" ADD CONSTRAINT "supplier_settlements_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
