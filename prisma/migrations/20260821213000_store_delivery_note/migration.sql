-- A vitrine prometia "entrega ou retirada combinada com a loja" sem lugar nenhum para a loja
-- dizer COMO. Quem compra ficava esperando um telefonema para descobrir se retira ou recebe.
-- Texto livre: combinação de entrega em comunidade não cabe em enum.

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "delivery_note" TEXT;
