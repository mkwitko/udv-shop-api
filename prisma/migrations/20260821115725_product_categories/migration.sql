-- AlterTable
ALTER TABLE "products" ADD COLUMN     "category_id" UUID;

-- CreateTable
CREATE TABLE "product_categories" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_categories_store_id_position_idx" ON "product_categories"("store_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_store_id_slug_key" ON "product_categories"("store_id", "slug");

-- CreateIndex
CREATE INDEX "products_store_id_category_id_active_created_at_id_idx" ON "products"("store_id", "category_id", "active", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "products_store_id_active_price_cents_id_idx" ON "products"("store_id", "active", "price_cents", "id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "product_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
