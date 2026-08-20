-- AlterTable
ALTER TABLE "stores" ALTER COLUMN "application_fee_bps" SET DEFAULT 0;

-- Lojas que já existiam ficaram com os 500 bps do default antigo. A decisão comercial é
-- que ninguém paga comissão por venda, então zera o que está no banco também — só mudar o
-- default deixaria as lojas atuais cobrando 5% para sempre.
UPDATE "stores" SET "application_fee_bps" = 0 WHERE "application_fee_bps" <> 0;
