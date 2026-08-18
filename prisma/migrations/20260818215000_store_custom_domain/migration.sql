-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "custom_domain" TEXT,
ADD COLUMN     "custom_domain_verified_at" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "stores_custom_domain_key" ON "stores"("custom_domain");
