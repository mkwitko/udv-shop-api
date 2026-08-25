import { createHmac, timingSafeEqual } from "node:crypto";
import { wooviComment } from "../../lib/woovi-comment.js";
import { badGateway, ServiceUnavailableError } from "../../shared/errors.js";

export type CreateChargeInput = {
  amountCents: number;
  correlationID: string;
  expiresInSeconds: number;
  splitPixKey: string;
  splitValueCents: number;
  comment: string;
};

export type CreateSubAccountInput = { name: string; pixKey: string };

/** Cobrança sem split: o dinheiro fica na conta da plataforma. Hoje só a verificação usa. */
export type CreatePlainChargeInput = {
  amountCents: number;
  correlationID: string;
  expiresInSeconds: number;
  comment: string;
};

/**
 * Dono de uma chave Pix segundo o DICT. O nome vem inteiro; o taxID vem mascarado quando é
 * CPF ("000.***.***-91") e inteiro quando é CNPJ — quem mascara é a Woovi, não nós.
 */
export type PixKeyOwner = {
  /** Chave normalizada pela Woovi (CPF/CNPJ só dígitos, e-mail minúsculo, telefone E.164). */
  pixKey: string;
  type: "CPF" | "CNPJ" | "EMAIL" | "PHONE" | "RANDOM" | "EVP";
  name: string;
  taxId: string;
};

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
  /**
   * Consulta o dono da chave no DICT. `null` quando a chave não existe — chave que o Banco
   * Central não conhece não é erro nosso, é dado errado que a tela precisa explicar.
   *
   * A Woovi limita a taxa desta consulta por regra do BC, e 404 repetido puxa 429: por isso
   * o resultado é guardado na loja em vez de consultado a cada tela.
   */
  checkPixKey(pixKey: string): Promise<PixKeyOwner | null>;
  /** Cobrança sem split, para a plataforma receber o centavo da prova de posse. */
  createPlainCharge(input: CreatePlainChargeInput): Promise<{
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

  /**
   * A Woovi nunca redireciona uma chamada de API. Um 3xx aqui é sempre base errada
   * (`api-sandbox.woovi.com` redireciona para a home): sem `redirect: "manual"`, o fetch
   * seguia para a landing page, devolvia 200 em HTML e o erro chegava como um
   * `SyntaxError` de JSON sem dizer com quem tínhamos falado.
   */
  function rejeitarRedirect(res: Response, path: string): void {
    if (res.status < 300 || res.status >= 400) return;
    throw badGateway("woovi_error", {
      motivo: "base da Woovi respondeu redirect",
      status: res.status,
      location: res.headers.get("location"),
      baseUrl,
      path,
    });
  }

  async function get(path: string): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        headers: { Authorization: cfg.apiKey },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw badGateway("woovi_unreachable", err);
    }
    rejeitarRedirect(res, path);
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

  /** POST cru: quem chama decide o que fazer com status fora da faixa 2xx. */
  async function postRaw(path: string, body: unknown): Promise<{ status: number; text: string }> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { Authorization: cfg.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw badGateway("woovi_unreachable", err);
    }
    rejeitarRedirect(res, path);
    return { status: res.status, text: await res.text() };
  }

  async function post(path: string, body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { Authorization: cfg.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
      });
    } catch (err) {
      throw badGateway("woovi_unreachable", err);
    }
    rejeitarRedirect(res, path);
    const text = await res.text();
    if (!res.ok) throw badGateway("woovi_error", { status: res.status, body: text.slice(0, 400) });
    try {
      return JSON.parse(text);
    } catch {
      throw badGateway("woovi_error", {
        motivo: "resposta 2xx sem JSON",
        path,
        status: res.status,
        baseUrl,
        body: text.slice(0, 400),
      });
    }
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
          redirect: "manual",
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        throw badGateway("woovi_unreachable", err);
      }
      rejeitarRedirect(res, path);
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
        // Travessão e afins fazem a Woovi recusar a cobrança inteira como "emoji" — ver lib.
        comment: wooviComment(input.comment),
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
    async checkPixKey(pixKey) {
      // A chave vai no corpo, não na URL: chave com caractere especial (e-mail, +55…)
      // quebrava a variante em path — é a própria Woovi que recomenda esta.
      const { status, text } = await postRaw("/api/v1/pix-keys/check", { pixKey });
      // Chave que o Banco Central não conhece não é falha da plataforma: é dado errado, e a
      // tela precisa dizer isso em vez de "tente mais tarde".
      if (status === 404) return null;
      // O limite é do BC e conta 404 repetido. Cair aqui não invalida a chave: é "agora não".
      if (status === 429) throw new ServiceUnavailableError("woovi_pix_key_check_rate_limited");
      if (status < 200 || status >= 300) {
        throw badGateway("woovi_error", { status, body: text.slice(0, 400) });
      }
      let data: {
        pixKey?: string;
        type?: string;
        owner?: { name?: string; taxID?: string };
      };
      try {
        data = JSON.parse(text);
      } catch {
        // 2xx com HTML não é resposta da API da Woovi: é base errada, proxy de saída ou
        // página de bloqueio no caminho. Sem status, host e trecho do corpo no log, isso
        // chega como um `SyntaxError` mudo e não dá para saber com quem falamos.
        throw badGateway("woovi_error", {
          motivo: "pix-keys/check devolveu corpo não-JSON",
          status,
          baseUrl,
          body: text.slice(0, 400),
        });
      }
      // Sem dono não há com o que comparar o pagador — tratar como chave desconhecida seria
      // mentira, então é falha de contrato do provedor.
      if (!data.owner?.name || !data.owner.taxID || !data.pixKey) {
        throw badGateway("woovi_error", { motivo: "pix-keys/check sem dono", status });
      }
      return {
        pixKey: data.pixKey,
        type: (data.type ?? "RANDOM") as PixKeyOwner["type"],
        name: data.owner.name,
        taxId: data.owner.taxID,
      };
    },
    async createPlainCharge(input) {
      // Sem `splits`: o centavo da prova de posse fica na conta da plataforma. Se fosse
      // com split, o dinheiro voltaria para a subconta da chave que ainda não foi provada.
      const data = (await post("/api/v1/charge", {
        value: input.amountCents,
        correlationID: input.correlationID,
        expiresIn: input.expiresInSeconds,
        comment: wooviComment(input.comment),
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
