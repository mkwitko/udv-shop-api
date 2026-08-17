import { createHmac, timingSafeEqual } from "node:crypto";
import { badGateway } from "../../shared/errors.js";

export type CreateChargeInput = {
  amountCents: number;
  correlationID: string;
  expiresInSeconds: number;
  splitPixKey: string;
  splitValueCents: number;
  comment: string;
};

export type CreateSubAccountInput = { name: string; pixKey: string };

export interface WooviGateway {
  createSubAccount(input: CreateSubAccountInput): Promise<{ subAccountId: string }>;
  createCharge(input: CreateChargeInput): Promise<{
    providerId: string;
    brCode: string;
    qrCodeImageUrl: string;
    expiresAt: string;
  }>;
  refundCharge(input: { chargeCorrelationID: string; refundCorrelationID: string }): Promise<void>;
  verifyWebhook(rawBody: Buffer, signature: string): boolean;
}

export function createWooviGateway(cfg: {
  apiKey: string;
  webhookHmacSecret: string;
  baseUrl?: string;
}): WooviGateway {
  const baseUrl = cfg.baseUrl ?? "https://api.woovi.com";

  async function post(path: string, body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { Authorization: cfg.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw badGateway("woovi_unreachable", err);
    }
    if (!res.ok) throw badGateway("woovi_error", { status: res.status, body: await res.text() });
    return res.json();
  }

  return {
    async createSubAccount(input) {
      // A subconta é identificada pela própria chave Pix — é ela que volta em
      // `splits[].pixKey` na cobrança com SPLIT_SUB_ACCOUNT. O id devolvido pela Woovi
      // é lido de forma defensiva porque o formato da resposta ainda não foi verificado
      // contra a conta real (risco registrado na spec §11); o fallback é a chave.
      const data = (await post("/api/v1/subaccount", {
        name: input.name,
        pixKey: input.pixKey,
      })) as { subAccount?: { id?: string; pixKey?: string } };
      return { subAccountId: data.subAccount?.id ?? data.subAccount?.pixKey ?? input.pixKey };
    },
    async createCharge(input) {
      const data = (await post("/api/v1/charge", {
        value: input.amountCents,
        correlationID: input.correlationID,
        expiresIn: input.expiresInSeconds,
        comment: input.comment,
        splits: [
          {
            pixKey: input.splitPixKey,
            value: input.splitValueCents,
            splitType: "SPLIT_SUB_ACCOUNT",
          },
        ],
      })) as {
        charge: { identifier: string; qrCodeImage: string; expiresDate: string };
        brCode: string;
      };
      return {
        providerId: data.charge.identifier,
        brCode: data.brCode,
        qrCodeImageUrl: data.charge.qrCodeImage,
        expiresAt: data.charge.expiresDate,
      };
    },
    async refundCharge({ chargeCorrelationID, refundCorrelationID }) {
      await post(`/api/v1/charge/${chargeCorrelationID}/refund`, {
        correlationID: refundCorrelationID,
      });
    },
    verifyWebhook(rawBody, signature) {
      const expected = createHmac("sha1", cfg.webhookHmacSecret).update(rawBody).digest("base64");
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      return a.length === b.length && timingSafeEqual(a, b);
    },
  };
}
