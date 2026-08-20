-- AlterTable
ALTER TABLE "raffle_prizes" ADD COLUMN     "description" TEXT,
ADD COLUMN     "images" TEXT[] DEFAULT ARRAY[]::TEXT[];
