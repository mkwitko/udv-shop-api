-- Sorteio já realizado com janela aberta é um beco sem saída: como janela nula vale
-- infinito, ele colide com qualquer sorteio novo, e fechá-la pelo PUT é impossível
-- porque reconfigurar exige status `open`. Toda campanha que existia antes das janelas
-- caiu nisso. A janela de um sorteio realizado termina quando ele foi sorteado.
UPDATE "raffles"
SET "ends_at" = "drawn_at"
WHERE "status" <> 'open' AND "ends_at" IS NULL AND "drawn_at" IS NOT NULL;
