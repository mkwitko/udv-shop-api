-- Na Woovi a subconta É a chave Pix: `GET/POST /api/v1/subaccount/{pixKey}` não tem id
-- separado. Sem unicidade, uma segunda loja que cadastrasse a mesma chave passaria a
-- operar a subconta da primeira: veria o saldo dela e poderia sacá-lo quando quisesse. O
-- dinheiro cai na chave (ninguém rouba por aí), mas reembolso sai da subconta — subconta
-- esvaziada fora de hora é reembolso pago pela plataforma. E as receitas das duas lojas se
-- misturariam num saldo só, sem como dizer de quem é o dinheiro.
--
-- Isto NÃO é prova de posse da chave: quem cadastra primeiro trava a chave para os outros.
-- Enquanto a verificação (1 centavo saindo da chave) não existir, chave travada por outra
-- loja é caso de suporte.

-- Duplicata aqui é configuração de dinheiro: falhar a migração e resolver à mão é melhor
-- que escolher sozinho qual loja perde a chave e fica com o checkout Pix quebrado. O erro
-- cita store_id e não a chave: chave Pix não vai para log.
DO $$
DECLARE
  duplicadas text;
BEGIN
  SELECT string_agg(ids, ' | ') INTO duplicadas
  FROM (
    SELECT string_agg(id::text, ',' ORDER BY created_at) AS ids
    FROM stores
    WHERE woovi_pix_key IS NOT NULL
    GROUP BY woovi_pix_key
    HAVING count(*) > 1
  ) AS grupos;

  IF duplicadas IS NOT NULL THEN
    RAISE EXCEPTION 'chave Pix repetida entre lojas (grupos por store_id: %). Resolva antes de migrar: cada chave pertence a uma loja só, e a subconta com saldo tem de ser sacada antes de liberar a chave.', duplicadas;
  END IF;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX "stores_woovi_pix_key_key" ON "stores"("woovi_pix_key");
