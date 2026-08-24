import { describe, expect, it } from "vitest";
import { compareTaxId, maskTaxId, normalizeOwnerName } from "../../src/lib/pix-key-owner.js";

describe("compareTaxId — dono da chave × quem pagou o centavo", () => {
  it("CPF mascarado bate quando os dígitos revelados batem", () => {
    // é o formato que a Woovi devolve em pix-keys/check: 3 primeiros + 2 últimos
    expect(compareTaxId("000.***.***-91", "00000000191")).toEqual({ result: "match" });
  });

  it("CPF mascarado recusa quando um dígito revelado difere", () => {
    expect(compareTaxId("000.***.***-91", "00000000192")).toEqual({ result: "mismatch" });
    expect(compareTaxId("000.***.***-91", "10000000191")).toEqual({ result: "mismatch" });
  });

  it("CNPJ vem inteiro e compara exato", () => {
    expect(compareTaxId("44720743000101", "44.720.743/0001-01")).toEqual({ result: "match" });
    expect(compareTaxId("44720743000101", "44720743000102")).toEqual({ result: "mismatch" });
  });

  it("CPF contra CNPJ é pessoa diferente, não dúvida", () => {
    expect(compareTaxId("000.***.***-91", "44720743000101")).toEqual({ result: "mismatch" });
  });

  it("máscara que revela menos que o mínimo não decide", () => {
    // se a Woovi mudar a máscara, o certo é a plataforma dizer que não sabe — não aprovar
    const veredito = compareTaxId("0**.***.***-**", "00000000191");
    expect(veredito.result).toBe("inconclusive");
  });

  it("documento do pagador fora de CPF/CNPJ não decide", () => {
    expect(compareTaxId("000.***.***-91", "123").result).toBe("inconclusive");
  });
});

describe("normalizeOwnerName", () => {
  it("tira acento, caixa e pontuação", () => {
    expect(normalizeOwnerName("Núcleo Estrela do Norte")).toBe("nucleo estrela do norte");
    expect(normalizeOwnerName("MARIA S. SILVA")).toBe("maria s silva");
  });
});

describe("maskTaxId", () => {
  it("guarda só as pontas do documento de quem pagou", () => {
    expect(maskTaxId("00000000191")).toBe("000******91");
    expect(maskTaxId("44720743000101")).toBe("447*********01");
  });

  it("documento curto não vira dado parcial vazando", () => {
    expect(maskTaxId("12")).toBe("***");
  });
});
