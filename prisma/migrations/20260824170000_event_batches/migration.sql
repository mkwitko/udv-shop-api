-- Venda em lotes: "1º lote R$ 30", "2º lote R$ 40". É como evento de comunidade enche antes
-- da hora — quem compra cedo paga menos — e não cabia no preço único do evento.
--
-- O lote ativo é o primeiro (por `position`) que ainda tem vaga E está dentro da janela.
-- Evento SEM lote continua vendendo pelo próprio preço: o mutirão a R$ 10 não paga o custo
-- de cadastrar lote nenhum. Daí `events.price_cents` e `events.seats` continuarem existindo.

-- CreateTable
CREATE TABLE "event_batches" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "seats" INTEGER NOT NULL DEFAULT 0,
    "opens_at" TIMESTAMP(3),
    "closes_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "event_batches_event_id_position_key" ON "event_batches"("event_id", "position");
CREATE INDEX "event_batches_event_id_idx" ON "event_batches"("event_id");

-- AddForeignKey
ALTER TABLE "event_batches" ADD CONSTRAINT "event_batches_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: de qual lote a vaga saiu
ALTER TABLE "order_items" ADD COLUMN "event_batch_id" UUID;

-- CreateIndex
CREATE INDEX "order_items_event_batch_id_idx" ON "order_items"("event_batch_id");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_event_batch_id_fkey" FOREIGN KEY ("event_batch_id") REFERENCES "event_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Lote sem evento é linha órfã: um item de produto não sai de lote de evento nenhum.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_lote_pede_evento"
  CHECK ("event_batch_id" IS NULL OR "event_id" IS NOT NULL);
