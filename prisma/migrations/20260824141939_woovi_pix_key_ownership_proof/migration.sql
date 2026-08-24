-- Prova de posse da chave Pix: a loja paga R$ 0,01 para a plataforma DA CONTA DA CHAVE que
-- declarou, e o webhook da cobrança traz o CPF/CNPJ de quem pagou. Comparado com o dono da
-- chave no DICT (`POST /api/v1/pix-keys/check`), é o que separa "declarei uma chave" de
-- "essa chave é minha" — e barra usar a chave de um terceiro como fantoche das vendas.

-- CreateEnum
CREATE TYPE "WooviPixKeyStatus" AS ENUM ('legacy', 'pending', 'verified');

-- CreateEnum
CREATE TYPE "WooviPixKeyVerificationStatus" AS ENUM ('pending', 'verified', 'rejected', 'expired');

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "woovi_pix_key_owner_name" TEXT,
ADD COLUMN     "woovi_pix_key_owner_tax_id" TEXT,
ADD COLUMN     "woovi_pix_key_status" "WooviPixKeyStatus",
ADD COLUMN     "woovi_pix_key_verified_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "woovi_pix_key_verifications" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "pix_key" TEXT NOT NULL,
    "owner_name" TEXT NOT NULL,
    "owner_tax_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "br_code" TEXT NOT NULL,
    "qr_code_url" TEXT NOT NULL,
    "status" "WooviPixKeyVerificationStatus" NOT NULL DEFAULT 'pending',
    "payer_name" TEXT,
    "payer_tax_id_masked" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "woovi_pix_key_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "woovi_pix_key_verifications_store_id_created_at_idx" ON "woovi_pix_key_verifications"("store_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "woovi_pix_key_verifications" ADD CONSTRAINT "woovi_pix_key_verifications_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Quem já tinha chave gravada continua recebendo: virar `pending` aqui tirava do ar, sem
-- aviso, a loja que estava vendendo hoje — pior que o risco que a verificação cobre.
-- `legacy` diz a verdade sobre esses dados: chave declarada, posse nunca provada. A gestão
-- pede a prova, e a chave que for trocada daqui para frente nasce `pending`.
UPDATE "stores" SET "woovi_pix_key_status" = 'legacy' WHERE "woovi_pix_key" IS NOT NULL;
