-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "claimed_at" TIMESTAMP(3),
ADD COLUMN     "claimed_by" TEXT;
