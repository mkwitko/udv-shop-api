import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import { compareTaxId, maskTaxId, normalizeOwnerName } from "../lib/pix-key-owner.js";

/** Quem pagou o centavo, como vem no webhook da cobrança (`pix.payer`). */
export type VerificationPayer = { name: string | null; taxId: string | null };

/**
 * Fecha uma tentativa de prova de posse da chave Pix.
 *
 * A pergunta que isto responde é uma só: quem pagou o centavo é a mesma pessoa de quem é a
 * chave? O dono vem do DICT (guardado quando a tentativa começou) e o pagador vem do
 * webhook. Bater os dois é o que separa "declarei uma chave" de "essa chave é minha".
 *
 * Devolve `false` quando o `correlationID` não é de uma verificação — é assim que o
 * processador de webhook sabe que aquele pagamento é de um pedido, e segue o caminho dele.
 */
export async function settleWooviPixKeyVerification(deps: {
  db: PrismaClient;
  log: FastifyBaseLogger;
  verificationId: string;
  payer: VerificationPayer;
}): Promise<boolean> {
  const { db, log, verificationId, payer } = deps;
  const encontrada = await db.wooviPixKeyVerification.findUnique({
    where: { id: verificationId },
    include: { store: { select: { id: true, wooviPixKey: true } } },
  });
  if (!encontrada) return false;
  const verification = encontrada;
  // Webhook repetido é normal na Woovi: quem já foi decidido fica como está.
  if (verification.status !== "pending") return true;

  const payerTaxIdMasked = payer.taxId ? maskTaxId(payer.taxId) : null;
  const registro = { payerName: payer.name, payerTaxIdMasked };

  async function close(
    status: "verified" | "rejected" | "expired",
    motivo: string,
  ): Promise<boolean> {
    await db.wooviPixKeyVerification.update({
      where: { id: verification.id },
      data: { ...registro, status, settledAt: new Date() },
    });
    if (status === "verified") {
      await db.store.update({
        where: { id: verification.storeId },
        data: { wooviPixKeyStatus: "verified", wooviPixKeyVerifiedAt: new Date() },
      });
    }
    log.info(
      { storeId: verification.storeId, verificationId: verification.id, status, motivo },
      "prova de posse da chave Pix fechada",
    );
    return true;
  }

  // Trocar de chave depois de pedir a prova invalida a prova: ela vale para a chave que
  // estava declarada, não para a que está lá agora.
  if (verification.store.wooviPixKey !== verification.pixKey) {
    return close("expired", "chave da loja mudou depois do pedido");
  }
  if (!payer.taxId) {
    // Sem documento do pagador não há comparação possível. Não é recusa da loja: é o
    // provedor mandando menos do que documenta, e a plataforma precisa ver isso.
    log.error(
      { storeId: verification.storeId, verificationId: verification.id },
      "webhook de verificação sem CPF/CNPJ do pagador: nada a comparar",
    );
    return true;
  }

  const veredito = compareTaxId(verification.ownerTaxId, payer.taxId);
  if (veredito.result === "inconclusive") {
    // Fica pendente de propósito: aprovar sem saber é o buraco que a verificação fecha, e
    // recusar quem talvez seja o dono não custa menos. O log é o pedido de socorro.
    log.error(
      { storeId: verification.storeId, verificationId: verification.id, ...veredito },
      "prova de posse inconclusiva: formato do documento mudou no provedor",
    );
    return true;
  }
  if (veredito.result === "mismatch") {
    return close("rejected", "quem pagou não é o dono da chave");
  }

  // Nome diferente com documento igual é abreviação de banco ("MARIA S SILVA"), não fraude:
  // registra e segue. Recusar aqui derrubaria gente que é dona da chave.
  if (payer.name && normalizeOwnerName(payer.name) !== normalizeOwnerName(verification.ownerName)) {
    log.warn(
      { storeId: verification.storeId, verificationId: verification.id },
      "documento do pagador confere, nome escrito diferente",
    );
  }
  return close("verified", "documento do pagador é o do dono da chave");
}
