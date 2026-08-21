-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "images" TEXT[] DEFAULT ARRAY[]::TEXT[];
