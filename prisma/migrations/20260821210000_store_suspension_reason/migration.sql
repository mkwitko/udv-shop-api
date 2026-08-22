-- `suspended` era ambíguo: assinatura cancelada e suspensão por moderação viravam o mesmo
-- estado. Resultado: a loja que voltava a pagar continuava fora do ar até um platform_admin
-- reativar na mão. Com o motivo gravado, a assinatura ativa reativa o que ela mesma derrubou
-- e a decisão da plataforma continua valendo.
--
-- Backfill: toda loja hoje suspensa recebe `platform`. É o lado seguro — assumir `billing`
-- reativaria automaticamente lojas que foram tiradas do ar por decisão da plataforma.

-- CreateEnum
CREATE TYPE "StoreSuspensionReason" AS ENUM ('billing', 'platform');

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "suspension_reason" "StoreSuspensionReason";

UPDATE "stores" SET "suspension_reason" = 'platform' WHERE "status" = 'suspended';
