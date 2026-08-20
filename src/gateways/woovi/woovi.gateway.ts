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

export type WithdrawResult =
  /** Saque pedido à Woovi. */
  | { status: "requested" }
  /** Nada a sacar — subconta zerada. */
  | { status: "empty" }
  /** A Woovi recusou o saque desta subconta. A tela precisa dizer isso ao núcleo. */
  | { status: "blocked"; message: string };

export type SubAccountBalance = {
  name: string;
  pixKey: string;
  /** Saldo VIRTUAL em centavos: fica reservado do saldo da conta da plataforma. */
  balanceCents: number;
  /** Woovi pode bloquear saque da subconta; a tela precisa dizer isso em vez de falhar. */
  withdrawBlocked: boolean;
};

export interface WooviGateway {
  createSubAccount(input: CreateSubAccountInput): Promise<{ subAccountId: string }>;
  /** Saldo da subconta. `null` quando a Woovi não conhece essa chave. */
  getSubAccount(pixKey: string): Promise<SubAccountBalance | null>;
  /**
   * Saca TODO o saldo da subconta para a chave Pix dela. É o único momento em que o
   * dinheiro sai de verdade da conta da plataforma — split para subconta é virtual.
   *
   * Saldo zerado e saque bloqueado NÃO são erro: são o estado normal de uma subconta
   * que já sacou. Devolver isso como resultado (em vez de lançar) é o que impede o
   * outbox de gastar 5 tentativas e marcar `failed` por nada.
   */
  withdrawSubAccount(pixKey: string): Promise<WithdrawResult>;
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
  /** Um segredo por webhook configurado na Woovi, separados por vírgula no env. */
  const secrets = cfg.webhookHmacSecret
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  async function get(path: string): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        headers: { Authorization: cfg.apiKey },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw badGateway("woovi_unreachable", err);
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    // Verificado contra a Woovi em 20/08/2026: subconta desconhecida responde
    // `400 {"error":"Subconta não encontrada"}`, não 404. Sem tratar esse caso como
    // "não existe", uma chave Pix trocada (ou gravada pelo gateway falso) derrubava a
    // tela de Recebimento inteira com 502.
    const naoEncontrada =
      res.status === 404 || (res.status === 400 && /n[ãa]o encontrada/i.test(text));
    if (naoEncontrada) return { status: 404, body: null };
    if (!res.ok) {
      throw badGateway("woovi_error", { status: res.status, body: text.slice(0, 400) });
    }
    return { status: res.status, body: parsed };
  }

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
      // `splits[].pixKey` na cobrança com SPLIT_SUB_ACCOUNT. Verificado contra a Woovi
      // em 20/08/2026: a resposta é `{subAccount:{name,pixKey}}` e a listagem devolve
      // `{name,pixKey,withdrawBlocked,balance}` — não existe campo `id` em subconta.
      // O `data.subAccount?.id` fica como tolerância a mudança futura da API.
      const data = (await post("/api/v1/subaccount", {
        name: input.name,
        pixKey: input.pixKey,
      })) as { subAccount?: { id?: string; pixKey?: string } };
      return { subAccountId: data.subAccount?.id ?? data.subAccount?.pixKey ?? input.pixKey };
    },
    async getSubAccount(pixKey) {
      const { status, body } = await get(`/api/v1/subaccount/${encodeURIComponent(pixKey)}`);
      if (status === 404) return null;
      const data = body as {
        subAccount?: {
          name?: string;
          pixKey?: string;
          balance?: number;
          withdrawBlocked?: boolean;
        };
      };
      const sub = data.subAccount;
      if (!sub?.pixKey) return null;
      return {
        name: sub.name ?? "",
        pixKey: sub.pixKey,
        // Woovi fala em centavos em toda a API (o charge usa `value` em centavos)
        balanceCents: typeof sub.balance === "number" ? sub.balance : 0,
        withdrawBlocked: sub.withdrawBlocked === true,
      };
    },
    async withdrawSubAccount(pixKey) {
      const path = `/api/v1/subaccount/${encodeURIComponent(pixKey)}/withdraw`;
      let res: Response;
      try {
        res = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: { Authorization: cfg.apiKey, "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        throw badGateway("woovi_unreachable", err);
      }
      if (res.ok) return { status: "requested" };
      const text = (await res.text()).slice(0, 400);
      // Verificado contra a Woovi em 20/08/2026: saldo zero responde
      // `400 {"error":"Not enought balance.  "}` (o erro de digitação é deles).
      if (res.status === 400 && /not\s*enought?\s*balance/i.test(text)) {
        return { status: "empty" };
      }
      if (res.status === 400 || res.status === 403) {
        return { status: "blocked", message: text };
      }
      throw badGateway("woovi_error", { status: res.status, body: text });
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
      // A Woovi aceita UM evento por webhook, e a secret do HMAC é por webhook (Admin →
      // API/Plugins → o webhook). Como consumimos três eventos, são três webhooks e três
      // secrets: com um segredo só, dois terços dos avisos de pagamento seriam recusados
      // como assinatura inválida. Daí a lista.
      const received = Buffer.from(signature);
      return secrets.some((secret) => {
        const expected = Buffer.from(createHmac("sha1", secret).update(rawBody).digest("base64"));
        return expected.length === received.length && timingSafeEqual(expected, received);
      });
    },
  };
}
