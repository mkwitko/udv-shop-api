import { describe, expect, it } from "vitest";
import { wooviComment } from "../../src/lib/woovi-comment.js";

// A Woovi recusa o travessão como se fosse emoji:
//   400 {"error":"Emoji não é permitido no comentário"}
// Acento passa; o problema é a pontuação tipográfica que o app usa nos rótulos.
describe("wooviComment", () => {
  it("troca travessão por hífen", () => {
    expect(wooviComment("Doação — Núcleo Demo")).toBe("Doação - Núcleo Demo");
    expect(wooviComment("Pedido – Núcleo Demo")).toBe("Pedido - Núcleo Demo");
  });

  it("preserva acento, que a Woovi aceita", () => {
    expect(wooviComment("Doação Núcleo São José")).toBe("Doação Núcleo São José");
  });

  it("remove emoji de verdade", () => {
    expect(wooviComment("Doação 🎉 Núcleo")).toBe("Doação Núcleo");
  });

  it("troca aspas e reticências tipográficas", () => {
    expect(wooviComment("Pedido “especial”…")).toBe('Pedido "especial"...');
  });

  it("não deixa espaço duplicado nem sobra nas pontas", () => {
    expect(wooviComment("  Doação   🎉  Núcleo  ")).toBe("Doação Núcleo");
  });

  it("corta em 140 caracteres, que é o limite que o app já assumia", () => {
    expect(wooviComment("a".repeat(200))).toHaveLength(140);
  });
});
