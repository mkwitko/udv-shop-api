import { describe, expect, it } from "vitest";
import { wooviRetainedFeeCents } from "../../src/lib/provider-fee.js";

describe("wooviRetainedFeeCents", () => {
  it("retém a taxa de contrato inteira numa cobrança normal", () => {
    expect(wooviRetainedFeeCents(10_000, 85)).toBe(85);
  });

  it("nunca retém o valor inteiro da cobrança: a Woovi recusa split igual ao valor", () => {
    // Cobrança de R$ 0,85 com taxa de R$ 0,85: retendo tudo, o split iria a zero e a
    // Woovi devolve 400. A plataforma absorve o centavo — é o teto, não a regra.
    expect(wooviRetainedFeeCents(85, 85)).toBe(84);
  });

  it("retém no máximo o valor menos um centavo numa cobrança menor que a taxa", () => {
    expect(wooviRetainedFeeCents(50, 85)).toBe(49);
  });

  it("retém pelo menos 1 centavo mesmo com taxa configurada em zero", () => {
    // Split de 100% é recusado pela Woovi; sem este piso, taxa zero mataria todo Pix.
    expect(wooviRetainedFeeCents(10_000, 0)).toBe(1);
  });
});
