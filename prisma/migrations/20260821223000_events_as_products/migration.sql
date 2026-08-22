-- Evento é produto com data. Sessão, festa e mutirão não precisavam de máquina nova: com
-- `event_at` preenchido o produto vira ingresso e passa a viver na Agenda, reusando preço,
-- estoque (= vagas), fila de espera quando lota e o checkout inteiro (Pix, cartão, reserva,
-- aviso de venda à loja).
--
-- `checked_in_at` fica no item do pedido, não no pedido: a lista de presença é por evento e
-- um mesmo pedido pode levar ingresso de dois eventos.

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "event_at" TIMESTAMP(3),
ADD COLUMN     "event_ends_at" TIMESTAMP(3),
ADD COLUMN     "event_location" TEXT;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "checked_in_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "products_store_id_active_event_at_idx" ON "products"("store_id", "active", "event_at");
