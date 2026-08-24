-- Evento sai de dentro de produto e passa a ter tabela própria.
--
-- Desde 20260821223000_events_as_products, evento era produto com `event_at` preenchido.
-- Reusava preço, estoque, fila de espera e o checkout inteiro — barato de escrever, caro em
-- todo lugar depois: a vitrine tinha de filtrar evento fora em cada consulta, "estoque"
-- queria dizer vaga, e a tela de produto dizia "Este produto está esgotado" para uma sessão
-- lotada. O que não cabia no molde de produto era justamente o que define evento: data que
-- vence, lugar, e lista de quem vai.
--
-- Os ids são PRESERVADOS na cópia: `order_items` continua apontando para a mesma linha (só
-- troca de coluna), e a chave que o público conhece — o slug — segue valendo.

-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "seats" INTEGER NOT NULL DEFAULT 0,
    "at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3),
    "location" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "supplier_id" UUID,
    "payout_kind" "PayoutKind",
    "payout_value" INTEGER,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "events_store_id_slug_key" ON "events"("store_id", "slug");
CREATE INDEX "events_store_id_active_at_idx" ON "events"("store_id", "active", "at");
CREATE INDEX "events_supplier_id_idx" ON "events"("supplier_id");

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "events" ADD CONSTRAINT "events_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Cópia dos eventos que hoje vivem em `products`. `stock` vira `seats` (era o mesmo número
-- com nome errado). `category_id` NÃO vem: categoria é gaveta de vitrine, e evento nunca
-- apareceu na vitrine. `availability` também não: evento é vaga ou nada — lotado é seats 0.
INSERT INTO "events" (
  "id", "store_id", "slug", "name", "description", "price_cents", "currency", "images",
  "seats", "at", "ends_at", "location", "active", "created_at", "updated_at",
  "supplier_id", "payout_kind", "payout_value"
)
SELECT
  "id", "store_id", "slug", "name", "description", "price_cents", "currency", "images",
  "stock", "event_at", "event_ends_at", "event_location", "active", "created_at", "updated_at",
  "supplier_id", "payout_kind", "payout_value"
FROM "products"
WHERE "event_at" IS NOT NULL;

-- AlterTable: item de pedido aponta para produto OU evento
ALTER TABLE "order_items" ADD COLUMN "event_id" UUID;
ALTER TABLE "order_items" ALTER COLUMN "product_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "order_items_event_id_idx" ON "order_items"("event_id");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Ingressos já vendidos passam a apontar para o evento. Mesmo id, outra coluna.
UPDATE "order_items" oi
SET "event_id" = oi."product_id", "product_id" = NULL
WHERE oi."product_id" IN (SELECT "id" FROM "products" WHERE "event_at" IS NOT NULL);

-- A fila de espera nunca foi só de produto: quem quer vaga em sessão lotada espera igual.
-- O nome da tabela dizia o contrário, então ele muda junto.
ALTER TABLE "product_interests" RENAME TO "interests";
ALTER TYPE "ProductInterestStatus" RENAME TO "InterestStatus";

-- Índices e constraints carregam o nome antigo depois do RENAME: sem renomear, o próximo
-- `migrate diff` acusaria drift e tentaria recriar tudo.
ALTER TABLE "interests" RENAME CONSTRAINT "product_interests_pkey" TO "interests_pkey";
ALTER TABLE "interests" RENAME CONSTRAINT "product_interests_product_id_fkey" TO "interests_product_id_fkey";
ALTER TABLE "interests" RENAME CONSTRAINT "product_interests_user_id_fkey" TO "interests_user_id_fkey";
ALTER INDEX "product_interests_product_id_user_id_key" RENAME TO "interests_product_id_user_id_key";
ALTER INDEX "product_interests_product_id_status_idx" RENAME TO "interests_product_id_status_idx";
ALTER INDEX "product_interests_user_id_created_at_id_idx" RENAME TO "interests_user_id_created_at_id_idx";

ALTER TABLE "interests" ADD COLUMN "event_id" UUID;
ALTER TABLE "interests" ALTER COLUMN "product_id" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "interests_event_id_user_id_key" ON "interests"("event_id", "user_id");
CREATE INDEX "interests_event_id_status_idx" ON "interests"("event_id", "status");

-- AddForeignKey
ALTER TABLE "interests" ADD CONSTRAINT "interests_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Quem estava na fila de um evento lotado continua na fila — do evento.
UPDATE "interests" i
SET "event_id" = i."product_id", "product_id" = NULL
WHERE i."product_id" IN (SELECT "id" FROM "products" WHERE "event_at" IS NOT NULL);

-- Um alvo, exatamente um. Sem isto, um item sem produto e sem evento é um recibo que não
-- diz o que foi comprado, e um com os dois é uma venda que conta duas vezes no repasse.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_um_alvo"
  CHECK (("product_id" IS NULL) <> ("event_id" IS NULL));
ALTER TABLE "interests" ADD CONSTRAINT "interests_um_alvo"
  CHECK (("product_id" IS NULL) <> ("event_id" IS NULL));

-- Agora que nada mais aponta para eles como produto, os eventos saem de `products`.
DELETE FROM "products" WHERE "event_at" IS NOT NULL;

-- DropIndex
DROP INDEX "products_store_id_active_event_at_idx";

-- AlterTable
ALTER TABLE "products" DROP COLUMN "event_at",
DROP COLUMN "event_ends_at",
DROP COLUMN "event_location";
