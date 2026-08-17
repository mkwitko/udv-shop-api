import { describe, expect, it } from "vitest";
import { signAccessToken, verifyAccessToken } from "../../src/lib/jwt.js";

describe("jwt", () => {
  it("assina e verifica claims", async () => {
    const token = await signAccessToken({
      id: "11111111-1111-1111-1111-111111111111",
      platformAdmin: false,
      roles: { "22222222-2222-2222-2222-222222222222": "owner" },
    });
    const claims = await verifyAccessToken(token);
    expect(claims.sub).toBe("11111111-1111-1111-1111-111111111111");
    expect(claims.roles["22222222-2222-2222-2222-222222222222"]).toBe("owner");
  });

  it("rejeita token adulterado", async () => {
    const token = await signAccessToken({ id: "x", platformAdmin: false, roles: {} });
    await expect(verifyAccessToken(`${token}x`)).rejects.toThrow();
  });
});
