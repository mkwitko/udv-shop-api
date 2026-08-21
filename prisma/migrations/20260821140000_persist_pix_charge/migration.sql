-- A cobrança Pix passa a ser persistida. Sem isso ela só existia na memória do navegador: um
-- F5 na tela de pagamento perdia o QR code e deixava a pessoa com um pendente que não tinha
-- como pagar. Vale para quem está logado e para quem comprou sem conta.
--
-- Cartão fica de fora de propósito: é síncrono, e o clientSecret morre com a tentativa.

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "pix_br_code" TEXT,
ADD COLUMN     "pix_qr_code_url" TEXT;
