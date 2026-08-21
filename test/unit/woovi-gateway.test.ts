import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWooviGateway } from "../../src/gateways/woovi/woovi.gateway.js";

describe("woovi verifyWebhook", () => {
  const gw = createWooviGateway({ apiKey: "k", webhookHmacSecret: "segredo" });
  const body = Buffer.from('{"event":"OPENPIX:CHARGE_COMPLETED"}');

  it("aceita assinatura HMAC-SHA1 base64 correta", () => {
    const sig = createHmac("sha1", "segredo").update(body).digest("base64");
    expect(gw.verifyWebhook(body, sig)).toBe(true);
  });

  it("rejeita assinatura errada e de tamanho diferente", () => {
    expect(gw.verifyWebhook(body, "aaaa")).toBe(false);
    const other = createHmac("sha1", "outro-segredo").update(body).digest("base64");
    expect(gw.verifyWebhook(body, other)).toBe(false);
  });
});

describe("woovi verifyWebhook — um segredo por webhook", () => {
  // Um evento por webhook na Woovi ⇒ três webhooks ⇒ três secrets. Todas valem.
  const gw = createWooviGateway({
    apiKey: "k",
    webhookHmacSecret: " pago , expirado ,estornado ",
  });
  const body = Buffer.from('{"event":"OPENPIX:TRANSACTION_REFUND_RECEIVED"}');

  it("aceita a assinatura de qualquer um dos webhooks configurados", () => {
    for (const secret of ["pago", "expirado", "estornado"]) {
      const sig = createHmac("sha1", secret).update(body).digest("base64");
      expect(gw.verifyWebhook(body, sig)).toBe(true);
    }
  });

  it("recusa segredo que não está na lista", () => {
    const sig = createHmac("sha1", "outro").update(body).digest("base64");
    expect(gw.verifyWebhook(body, sig)).toBe(false);
  });

  it("sem nenhum segredo configurado recusa tudo, em vez de aceitar qualquer coisa", () => {
    const semSecret = createWooviGateway({ apiKey: "k", webhookHmacSecret: "" });
    const sig = createHmac("sha1", "qualquer").update(body).digest("base64");
    expect(semSecret.verifyWebhook(body, sig)).toBe(false);
  });
});

describe("woovi getSubAccount", () => {
  function gatewayComResposta(status: number, body: string) {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(body, { status, headers: { "content-type": "application/json" } })) as never;
    const gw = createWooviGateway({ apiKey: "k", webhookHmacSecret: "s" });
    return { gw, restore: () => (globalThis.fetch = original) };
  }

  // A Woovi responde 400 (não 404) para chave desconhecida. Tratar isso como erro fazia
  // a tela de Recebimento morrer em 502 quando a chave gravada não existia mais lá.
  it("chave desconhecida vira null, não erro", async () => {
    const { gw, restore } = gatewayComResposta(400, '{"error":"Subconta não encontrada"}');
    try {
      await expect(gw.getSubAccount("sumiu@example.org")).resolves.toBeNull();
    } finally {
      restore();
    }
  });

  it("lê saldo e bloqueio do formato real da Woovi", async () => {
    const { gw, restore } = gatewayComResposta(
      200,
      '{"subAccount":{"name":"N","pixKey":"a@b.org","balance":4500,"withdrawBlocked":true}}',
    );
    try {
      await expect(gw.getSubAccount("a@b.org")).resolves.toEqual({
        name: "N",
        pixKey: "a@b.org",
        balanceCents: 4500,
        withdrawBlocked: true,
      });
    } finally {
      restore();
    }
  });

  it("400 de outro motivo continua sendo erro de verdade", async () => {
    const { gw, restore } = gatewayComResposta(400, '{"error":"parâmetro inválido"}');
    try {
      await expect(gw.getSubAccount("a@b.org")).rejects.toThrow();
    } finally {
      restore();
    }
  });
});

describe("woovi withdrawSubAccount", () => {
  function gatewayComResposta(status: number, body: string) {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(body, { status })) as never;
    const gw = createWooviGateway({ apiKey: "k", webhookHmacSecret: "s" });
    return { gw, restore: () => (globalThis.fetch = original) };
  }

  // Saldo zero é o estado NORMAL de subconta que já sacou. Se isso virasse exceção, o
  // outbox gastaria 5 tentativas e marcaria `failed` num caso benigno.
  it("saldo insuficiente é `empty`, não exceção", async () => {
    const { gw, restore } = gatewayComResposta(400, '{"error":"Not enought balance.  "}');
    try {
      await expect(gw.withdrawSubAccount("a@b.org")).resolves.toEqual({ status: "empty" });
    } finally {
      restore();
    }
  });

  it("saque aceito responde `requested`", async () => {
    const { gw, restore } = gatewayComResposta(200, '{"status":"OK"}');
    try {
      await expect(gw.withdrawSubAccount("a@b.org")).resolves.toEqual({ status: "requested" });
    } finally {
      restore();
    }
  });

  it("outro 400 é bloqueio: reportado, não silenciado nem retriado para sempre", async () => {
    const { gw, restore } = gatewayComResposta(400, '{"error":"subconta bloqueada"}');
    try {
      const r = await gw.withdrawSubAccount("a@b.org");
      expect(r.status).toBe("blocked");
    } finally {
      restore();
    }
  });
});

describe("woovi createCharge", () => {
  // A Woovi recusa a cobrança inteira com "Emoji não é permitido no comentário" diante de
  // travessão. O rótulo é montado longe daqui (`Doação — Núcleo X`), então a limpeza mora
  // no gateway: é a única porta por onde o texto sai para a Woovi.
  it("limpa o comentário antes de enviar", async () => {
    const original = globalThis.fetch;
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          charge: { identifier: "id", qrCodeImage: "img", expiresDate: "2026-01-01T00:00:00Z" },
          brCode: "000201",
        }),
        { status: 200 },
      );
    }) as never;
    const gw = createWooviGateway({ apiKey: "k", webhookHmacSecret: "s" });
    try {
      await gw.createCharge({
        amountCents: 2500,
        correlationID: "c1",
        expiresInSeconds: 1800,
        splitPixKey: "a@b.org",
        splitValueCents: 2499,
        comment: "Doação — Núcleo Demo",
      });
      expect(sent.comment).toBe("Doação - Núcleo Demo");
    } finally {
      globalThis.fetch = original;
    }
  });
});
