-- Taxa do provedor passa a ser descontada do repasse da loja (ADR-029).
-- Nullable sem default: NULL marca os pagamentos do modelo antigo, em que a plataforma
-- pagou a taxa. Preencher com 0 apagaria quanto o modelo antigo custou.
ALTER TABLE "payments" ADD COLUMN "provider_fee_cents" INTEGER;
ALTER TABLE "payments" ADD COLUMN "stripe_transfer_id" TEXT;
