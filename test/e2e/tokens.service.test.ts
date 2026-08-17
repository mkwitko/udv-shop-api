import { beforeEach, describe, expect, it } from "vitest";
import { createAuthRepository } from "../../src/http/api/auth/auth.repository.js";
import { createTokensService } from "../../src/http/api/auth/tokens.service.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";

const repo = createAuthRepository(db);
const tokens = createTokensService({ repo });

async function makeUser() {
  return db.user.create({
    data: { email: "t@example.org", name: "T", passwordHash: "x" },
  });
}

describe("tokens service", () => {
  beforeEach(resetDb);

  it("issue cria família e rotate troca token", async () => {
    const user = await makeUser();
    const first = await tokens.issue(user.id);
    expect(first.accessToken).toBeTruthy();

    const second = await tokens.rotate(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
  });

  it("reuso de refresh antigo revoga a família inteira", async () => {
    const user = await makeUser();
    const first = await tokens.issue(user.id);
    const second = await tokens.rotate(first.refreshToken);

    // reuso do token já rotacionado → 401 e família morta
    await expect(tokens.rotate(first.refreshToken)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(tokens.rotate(second.refreshToken)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("rotate de token inexistente falha", async () => {
    await expect(tokens.rotate("nao-existe")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
