import type { Store } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "../../../config/env.js";
import { maskPixKey } from "../../../lib/mask.js";
import { ownerTaxIdOf } from "../../../lib/pix-key-owner.js";
import { ServiceUnavailableError, ValidationError } from "../../../shared/errors.js";

/**
 * URLs de volta do onboarding hospedado, sempre no domínio do front. Aponta para
 * Recebimento porque é lá que o estado da conta aparece — mandar para uma rota que
 * não existe deixava a pessoa num 404 justamente ao voltar do banco.
 */
export function connectUrls(slug: string) {
  const base = `${env.WEB_ORIGIN}/gestao/${slug}/recebimento`;
  return { refreshUrl: `${base}?connect=refresh`, returnUrl: `${base}?connect=ok` };
}

/**
 * Pergunta ao DICT de quem é a chave. Devolve `null` quando não deu para perguntar agora —
 * a chave é gravada mesmo assim, como `pending`, e a prova de posse consulta de novo. Chave
 * sem dono confirmado não recebe nada, então esperar não protege ninguém; o que ela custaria
 * é a loja travada num 503 do provedor no meio do cadastro.
 */
export async function checkPixKeyOwner(
  app: FastifyInstance,
  req: FastifyRequest,
  pixKey: string,
): Promise<{ name: string; taxId: string } | null> {
  let owner: Awaited<ReturnType<typeof app.gateways.woovi.checkPixKey>>;
  try {
    owner = await app.gateways.woovi.checkPixKey(pixKey);
  } catch (err) {
    // O limite de consulta é do Banco Central, não nosso: não é motivo para recusar a chave.
    if (err instanceof ServiceUnavailableError) {
      req.log.warn({ err: err.message }, "consulta de chave Pix indisponível: segue sem o dono");
      return null;
    }
    throw err;
  }
  // Chave que o Banco Central não conhece é quase sempre erro de digitação. Dizer isso na
  // hora vale mais que deixar a pessoa descobrir na hora de receber.
  if (!owner) throw new ValidationError("woovi_pix_key_not_found");
  return { name: owner.name, taxId: ownerTaxIdOf(owner) };
}

export function toConnectStatusResponse(store: Store) {
  return {
    stripe: {
      connected: store.stripeAccountId !== null,
      transfersEnabled: store.stripeTransfersEnabled,
      chargesEnabled: store.stripeChargesEnabled,
      payoutsEnabled: store.stripePayoutsEnabled,
      detailsSubmitted: store.stripeDetailsSubmitted,
    },
    woovi: {
      connected: store.wooviPixKey !== null,
      pixKeyMasked: maskPixKey(store.wooviPixKey),
      keyStatus: store.wooviPixKeyStatus,
      // Nome do dono vai inteiro de propósito: é a conferência que a loja faz com o olho
      // ("essa chave é da tesoureira, não minha") e ela já sabe de quem é a chave que
      // digitou. O documento fica de fora — para conferir, o nome basta.
      ownerName: store.wooviPixKeyOwnerName,
    },
    applicationFeeBps: store.applicationFeeBps,
    // Declaração, não cálculo: a taxa do provedor é DESCONTADA DO REPASSE da loja
    // (ADR-029). Aparece aqui porque a loja tem de saber por que recebeu menos que o preço
    // que vendeu — descobrir isso pelo extrato, depois, seria pegadinha.
    providerFees: {
      pix: env.PROVIDER_FEE_PIX_TEXT || null,
      card: env.PROVIDER_FEE_CARD_TEXT || null,
    },
  };
}
