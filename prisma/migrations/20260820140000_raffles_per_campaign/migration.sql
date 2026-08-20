-- Sorteio deixa de ser 1:1 com a campanha: campanha longa tem um sorteio por período.
-- Os DEFAULT existem só para as linhas já gravadas (o schema Prisma não os declara, então
-- o código sempre informa sequence/title/starts_at). Depois do backfill eles saem.
ALTER TABLE "raffles" ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "raffles" ADD COLUMN "title" TEXT NOT NULL DEFAULT 'Sorteio';
ALTER TABLE "raffles" ADD COLUMN "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "raffles" ADD COLUMN "ends_at" TIMESTAMP(3);

-- Sorteio que já existia vale desde que foi criado e não tem fim: é o corrente.
UPDATE "raffles" SET "starts_at" = "created_at";

ALTER TABLE "raffles" ALTER COLUMN "sequence" DROP DEFAULT;
ALTER TABLE "raffles" ALTER COLUMN "title" DROP DEFAULT;
ALTER TABLE "raffles" ALTER COLUMN "starts_at" DROP DEFAULT;

DROP INDEX "raffles_campaign_id_key";
CREATE UNIQUE INDEX "raffles_campaign_id_sequence_key" ON "raffles"("campaign_id", "sequence");
CREATE INDEX "raffles_campaign_id_starts_at_idx" ON "raffles"("campaign_id", "starts_at");

-- A janela do sorteio precisa da data do PAGAMENTO. `created_at` é quando o checkout
-- abriu: um Pix pago horas depois cairia na janela errada.
ALTER TABLE "donations" ADD COLUMN "paid_at" TIMESTAMP(3);

-- Histórico: `updated_at` é a melhor aproximação disponível e nenhuma doação já gravada
-- está numa campanha com dois sorteios, então nenhuma decisão de janela depende dela.
UPDATE "donations" SET "paid_at" = "updated_at" WHERE "status" = 'paid';
