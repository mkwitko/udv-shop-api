import { describe, expect, it } from "vitest";
import { maskPhone } from "../../src/lib/mask.js";

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
