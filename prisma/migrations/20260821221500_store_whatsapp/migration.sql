-- Quem compra não tinha canal nenhum de volta: pagava, e falar com a loja dependia de a loja
-- ligar primeiro. O WhatsApp é o canal que essa comunidade já usa; guardado só com dígitos e
-- DDI, do mesmo jeito que o telefone de contato do pedido.

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "whatsapp" TEXT;
