import { db } from "../../infra/db/client.js";
import { logger } from "../../infra/observability/logger.js";
import { markPaymentPaid } from "../../workers/payment-routing.js";
import { settleWooviPixKeyVerification } from "../../workers/pix-key-verification.js";
import type { WooviGateway } from "./woovi.gateway.js";

/**
 * Gateway Pix de mentira para desenvolvimento local (DEV_FAKE_PAYMENTS=true).
 * Cria uma cobrança com QR ilustrativo e confirma o pagamento sozinho depois de
 * alguns segundos, pelo mesmo caminho que o webhook real usaria. Nunca chega em
 * produção — o env valida isso no boot.
 */
const CONFIRM_AFTER_MS = 8_000;

function fakeQrSvg(amountCents: number): string {
  const label = `PIX DEMO R$ ${(amountCents / 100).toFixed(2).replace(".", ",")}`;
  const cells = Array.from({ length: 64 }, (_, i) => {
    // padrão determinístico que lembra um QR — é só ilustração
    const x = i % 8;
    const y = Math.floor(i / 8);
    const on = (x * 7 + y * 13 + ((amountCents / 100) | 0)) % 3 !== 0;
    return on ? `<rect x="${20 + x * 20}" y="${20 + y * 20}" width="18" height="18"/>` : "";
  }).join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 224">` +
    `<rect width="200" height="224" fill="#fff"/>` +
    `<g fill="#111">${cells}</g>` +
    `<text x="100" y="214" font-family="sans-serif" font-size="12" text-anchor="middle" fill="#111">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export function createFakeWooviGateway(): WooviGateway {
  return {
    async createSubAccount(input) {
      return { subAccountId: `fake_sub_${input.pixKey}` };
    },
    // Saldo de mentira que acompanha o Pix falso: sempre algo a sacar, para a tela de
    // Recebimento poder ser exercitada sem Woovi de verdade.
    async getSubAccount(pixKey) {
      return { name: "Subconta demo", pixKey, balanceCents: 12_345, withdrawBlocked: false };
    },
    async withdrawSubAccount(pixKey) {
      logger.info({ pixKey }, "saque Pix falso (DEV_FAKE_PAYMENTS)");
      return { status: "requested" as const };
    },

    async createCharge(input) {
      const providerId = `fake_pix_${input.correlationID}`;
      setTimeout(() => {
        markPaymentPaid({
          db,
          log: logger,
          paymentId: input.correlationID,
          providerId,
        }).catch((error) => logger.error({ error }, "dev-fake-payments: confirmação falhou"));
      }, CONFIRM_AFTER_MS).unref();

      return {
        providerId,
        brCode: `00020126DEMO.colheita.fake/${input.correlationID}6304ABCD`,
        qrCodeImageUrl: fakeQrSvg(input.amountCents),
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
      };
    },

    // Dono de mentira, sempre o mesmo: o que a tela precisa exercitar é o fluxo, e o
    // pagador falso (abaixo) é gerado para bater com este documento.
    async checkPixKey(pixKey) {
      return { pixKey, type: "EMAIL" as const, name: "Dono Demo", taxId: "000.***.***-91" };
    },

    async createPlainCharge(input) {
      // Confirma sozinho como quem pagou fosse o dono da chave: em dev não existe app de
      // banco para pagar o centavo, e sem isso a prova de posse nunca fecharia localmente.
      setTimeout(() => {
        settleWooviPixKeyVerification({
          db,
          log: logger,
          verificationId: input.correlationID,
          payer: { name: "Dono Demo", taxId: "00000000191" },
        }).catch((error) => logger.error({ error }, "dev-fake-payments: verificação falhou"));
      }, CONFIRM_AFTER_MS).unref();

      return {
        providerId: `fake_pix_${input.correlationID}`,
        brCode: `00020126DEMO.colheita.fake/${input.correlationID}6304ABCD`,
        qrCodeImageUrl: fakeQrSvg(input.amountCents),
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
      };
    },

    async refundCharge() {
      // nada a fazer: não existe dinheiro de verdade aqui
    },

    verifyWebhook() {
      return true;
    },
  };
}
