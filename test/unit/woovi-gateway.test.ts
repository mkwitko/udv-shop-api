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

describe("woovi — resposta que não é da API", () => {
  const gw = createWooviGateway({
    apiKey: "k",
    webhookHmacSecret: "s",
    baseUrl: "https://api.exemplo-invalido.test",
  });

  it("não segue redirect: base errada devolvia a landing page em HTML como 200", async () => {
    const original = globalThis.fetch;
    const chamadas: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      chamadas.push(String(url));
      return new Response(null, { status: 302, headers: { location: "https://woovi.com/" } });
    }) as typeof fetch;
    try {
      await expect(gw.checkPixKey("a@b.com")).rejects.toMatchObject({
        message: "woovi_error",
        cause: { status: 302, location: "https://woovi.com/" },
      });
      // Uma chamada só: o redirect morre aqui em vez de virar GET na home.
      expect(chamadas).toEqual(["https://api.exemplo-invalido.test/api/v1/pix-keys/check"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("403 da consulta de chave é indisponibilidade, não 502: o cadastro grava a chave como pendente", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Sua conta não tem permissão para usar este endpoint" }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        },
      )) as typeof fetch;
    try {
      await expect(gw.checkPixKey("a@b.com")).rejects.toMatchObject({
        name: "ServiceUnavailableError",
        message: "woovi_pix_key_check_forbidden",
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("corpo 2xx sem JSON vira erro com status e trecho — não um SyntaxError mudo", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<!DOCTYPE html><html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch;
    try {
      await expect(gw.checkPixKey("a@b.com")).rejects.toMatchObject({
        message: "woovi_error",
        cause: { status: 200, body: "<!DOCTYPE html><html></html>" },
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
