import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ConflictError, ValidationError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { checkPixKeyOwner } from "../connect.helpers.js";
import { WooviPixKeyVerificationResponse } from "../connect.schema.js";

const Params = z.object({ slug: z.string() });

/** Um centavo. O valor não é a prova — quem paga é. */
const AMOUNT_CENTS = 1;
/** Tempo para abrir o app do banco e pagar. Passou disso, pede outra. */
const EXPIRES_IN_SECONDS = 60 * 60;

/**
 * Começa (ou devolve) a prova de posse da chave Pix da loja.
 *
 * A loja paga R$ 0,01 para a plataforma DA CONTA DA CHAVE que declarou. O webhook da
 * cobrança traz o CPF/CNPJ de quem pagou, e comparar isso com o dono da chave no Banco
 * Central é o que separa "declarei uma chave" de "essa chave é minha".
 *
 * Sem isso, alguém cadastra a chave de um terceiro e as vendas caem na conta de um inocente:
 * o dinheiro nunca é roubado (Pix sempre cai na chave), mas a trilha do golpe aponta para
 * quem não fez nada — e a loja de verdade fica sem o dinheiro que vendeu.
 */
export const verifyWooviPixKeyRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/stores/:slug/connect/woovi/verification",
    {
      config: {
        permissions: { any: ["store_owner"] },
        // cada tentativa cria uma cobrança na Woovi: limite baixo de propósito
        rateLimit: { max: 5, timeWindow: "10 minutes" },
      },
      schema: {
        operationId: "verifyWooviPixKey",
        tags: ["connect"],
        params: Params,
        response: { 200: WooviPixKeyVerificationResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "owner");
      requireWritableStore(req, store);
      if (!store.wooviPixKey) throw new ValidationError("payments_not_configured");
      if (store.wooviPixKeyStatus === "verified")
        throw new ConflictError("pix_key_already_verified");

      const agora = new Date();
      // Cobrança viva para a MESMA chave é devolvida em vez de refeita: o QR já está aberto
      // no celular de alguém, e trocar por outro faria o pagamento cair numa cobrança que a
      // tela não olha mais.
      const aberta = await db.wooviPixKeyVerification.findFirst({
        where: {
          storeId: store.id,
          pixKey: store.wooviPixKey,
          status: "pending",
          expiresAt: { gt: agora },
        },
        orderBy: { createdAt: "desc" },
      });
      if (aberta) {
        return {
          status: aberta.status,
          amountCents: aberta.amountCents,
          brCode: aberta.brCode,
          qrCodeImageUrl: aberta.qrCodeUrl,
          expiresAt: aberta.expiresAt.toISOString(),
          ownerName: aberta.ownerName,
        };
      }

      // O dono é consultado de novo aqui: a chave pode ter sido gravada num momento em que
      // o DICT estava fora, e sem dono não existe com o que comparar o pagador.
      const owner =
        store.wooviPixKeyOwnerName && store.wooviPixKeyOwnerTaxId
          ? { name: store.wooviPixKeyOwnerName, taxId: store.wooviPixKeyOwnerTaxId }
          : await checkPixKeyOwner(app, req, store.wooviPixKey);
      if (!owner) throw new ValidationError("woovi_pix_key_owner_unknown");
      if (!store.wooviPixKeyOwnerName) {
        await createStoresRepository(db).setWooviPixKeyOwner(store.id, owner);
      }

      const verification = await db.wooviPixKeyVerification.create({
        data: {
          storeId: store.id,
          pixKey: store.wooviPixKey,
          ownerName: owner.name,
          ownerTaxId: owner.taxId,
          amountCents: AMOUNT_CENTS,
          brCode: "",
          qrCodeUrl: "",
          expiresAt: new Date(agora.getTime() + EXPIRES_IN_SECONDS * 1000),
        },
      });

      // A cobrança nasce depois da linha no banco porque o `correlationID` É o id dela: é
      // por ele que o webhook do centavo encontra o caminho de volta.
      const charge = await app.gateways.woovi.createPlainCharge({
        amountCents: AMOUNT_CENTS,
        correlationID: verification.id,
        expiresInSeconds: EXPIRES_IN_SECONDS,
        comment: `Confirmacao de chave Pix ${store.name}`.slice(0, 140),
      });
      const salva = await db.wooviPixKeyVerification.update({
        where: { id: verification.id },
        data: { brCode: charge.brCode, qrCodeUrl: charge.qrCodeImageUrl },
      });

      return {
        status: salva.status,
        amountCents: salva.amountCents,
        brCode: salva.brCode,
        qrCodeImageUrl: salva.qrCodeUrl,
        expiresAt: salva.expiresAt.toISOString(),
        ownerName: salva.ownerName,
      };
    },
  );
};
