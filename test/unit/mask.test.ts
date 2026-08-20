import { describe, expect, it } from "vitest";
import { maskPhone, maskPixKey } from "../../src/lib/mask.js";

describe("maskPhone", () => {
  it("mostra DDD e os quatro últimos dígitos", () => {
    expect(maskPhone("48999995678")).toBe("(48) ****-5678");
    expect(maskPhone("(48) 99999-5678")).toBe("(48) ****-5678");
  });

  it("derruba o 55 do começo antes de ler o DDD", () => {
    expect(maskPhone("5548999995678")).toBe("(48) ****-5678");
  });

  it("número curto some ou vira só o fim", () => {
    expect(maskPhone("999")).toBeNull();
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone("")).toBeNull();
    expect(maskPhone("99995678")).toBe("****-5678");
  });
});

describe("maskPixKey", () => {
  it("e-mail mantém domínio e esconde o resto do início", () => {
    expect(maskPixKey("maria@gmail.com")).toBe("ma***@gmail.com");
    expect(maskPixKey("a@dominio.org")).toBe("a***@dominio.org");
  });

  it("telefone vira o formato que a pessoa reconhece", () => {
    expect(maskPixKey("+5548999995678")).toBe("(48) ****-5678");
    expect(maskPixKey("5548999995678")).toBe("(48) ****-5678");
  });

  // 11 dígitos é CPF e celular ao mesmo tempo: quem desempata é o +55
  it("CPF e CNPJ mostram só os quatro últimos", () => {
    expect(maskPixKey("12345678901")).toBe("•••••••8901");
    expect(maskPixKey("12345678000199")).toBe("••••••••••0199");
  });

  it("chave aleatória mostra começo e fim", () => {
    expect(maskPixKey("6f2c4b1a-9d3e-4a55-b0c7-1e2f3a4b5c6d")).toBe("6f2c…5c6d");
  });

  it("sem chave não inventa texto", () => {
    expect(maskPixKey(null)).toBeNull();
    expect(maskPixKey("   ")).toBeNull();
  });
});
