-- Convites de equipe da loja. Só o hash do token é guardado; o cru vai no e-mail.
CREATE TABLE "store_invites" (
  "id" UUID NOT NULL,
  "store_id" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "role" "StoreRole" NOT NULL,
  "token_hash" TEXT NOT NULL,
  "invited_by_user_id" UUID NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "accepted_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_invites_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "store_invites_token_hash_key" ON "store_invites"("token_hash");
CREATE INDEX "store_invites_store_id_email_idx" ON "store_invites"("store_id", "email");
ALTER TABLE "store_invites" ADD CONSTRAINT "store_invites_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "store_invites" ADD CONSTRAINT "store_invites_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
