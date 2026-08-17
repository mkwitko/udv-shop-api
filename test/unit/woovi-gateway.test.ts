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
