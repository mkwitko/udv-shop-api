import { describe, expect, it } from "vitest";
import { hostOf, isSameOrSubdomain, normalizeDomain } from "../../src/lib/domain.js";

describe("normalizeDomain", () => {
  it("aceita o que a pessoa cola e devolve forma canônica", () => {
    expect(normalizeDomain("https://Loja.Exemplo.org/")).toBe("loja.exemplo.org");
    expect(normalizeDomain(" loja.exemplo.org. ")).toBe("loja.exemplo.org");
    expect(normalizeDomain("loja.exemplo.org:443")).toBe("loja.exemplo.org");
    expect(normalizeDomain("http://loja.exemplo.org/produtos?x=1")).toBe("loja.exemplo.org");
  });

  it("recusa o que não é endereço público", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("loja")).toBeNull();
    expect(normalizeDomain("192.168.0.1")).toBeNull();
    expect(normalizeDomain("loja..exemplo.org")).toBeNull();
    expect(normalizeDomain("-loja.exemplo.org")).toBeNull();
    expect(normalizeDomain("lo ja.exemplo.org")).toBeNull();
    expect(normalizeDomain(`${"a".repeat(64)}.exemplo.org`)).toBeNull();
  });
});

describe("isSameOrSubdomain", () => {
  it("pega o próprio domínio e os filhos, não o vizinho parecido", () => {
    expect(isSameOrSubdomain("colheita.app", "colheita.app")).toBe(true);
    expect(isSameOrSubdomain("loja.colheita.app", "colheita.app")).toBe(true);
    expect(isSameOrSubdomain("naocolheita.app", "colheita.app")).toBe(false);
  });
});

describe("hostOf", () => {
  it("tira porta e caminho, e devolve null para lixo", () => {
    expect(hostOf("http://localhost:3000")).toBe("localhost");
    expect(hostOf("https://Colheita.app/x")).toBe("colheita.app");
    expect(hostOf("nao-e-url")).toBeNull();
  });
});
