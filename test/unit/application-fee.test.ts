import { describe, expect, it } from "vitest";
import { wooviApplicationFeeCents } from "../../src/lib/application-fee.js";

// A Woovi recusa split cujo valor é igual ao da cobrança:
//   400 {"error":"O valor total do split de pagamentoo não pode ser igual ao valor da cobrança"}
// Como toda loja hoje tem applicationFeeBps = 0 (o modelo é mensalidade, não comissão),
// o split nasceria com 100% e a cobrança Pix morreria antes de existir.
describe("wooviApplicationFeeCents", () => {
  it("retém 1 centavo quando a loja não tem comissão", () => {
    expect(wooviApplicationFeeCents(10_000, 0)).toBe(1);
  });

  it("preserva a comissão da loja quando ela existe", () => {
    expect(wooviApplicationFeeCents(10_000, 500)).toBe(500);
  });

  it("nunca deixa o split zerar a cobrança", () => {
    // fee calculada maior que o valor não deve sobrar como split negativo
    expect(wooviApplicationFeeCents(500, 500)).toBe(499);
    expect(wooviApplicationFeeCents(500, 600)).toBe(499);
  });

  it("aceita o menor valor de doação sem quebrar", () => {
    const fee = wooviApplicationFeeCents(500, 0);
    expect(fee).toBe(1);
    expect(500 - fee).toBeGreaterThan(0);
  });
});
