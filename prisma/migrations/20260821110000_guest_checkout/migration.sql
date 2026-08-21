-- Fluxo sem conta: e-mail deixa de ser obrigatório (quem chega só com telefone vira uma
-- conta leve, sem senha), o telefone passa a ser chave de identidade, e pedido/doação feitos
-- sem sessão ganham a chave do recibo público.
--
-- Sem backfill: `users.phone` está nulo em 100% das linhas hoje (nenhum código escrevia nele),
-- então o índice único nasce vazio e não há colisão possível.

-- AlterTable
ALTER TABLE "donations" ADD COLUMN     "public_token" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "public_token" TEXT;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "donations_public_token_key" ON "donations"("public_token");

-- CreateIndex
CREATE UNIQUE INDEX "orders_public_token_key" ON "orders"("public_token");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");
