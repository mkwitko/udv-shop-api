import { beforeEach, describe, expect, it } from "vitest";
import { createAuthRepository } from "../../src/http/api/auth/auth.repository.js";
import { createTokensService, hashToken } from "../../src/http/api/auth/tokens.service.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";

const repo = createAuthRepository(db);
const tokens = createTokensService({ repo });

async function makeUser() {
  return db.user.create({
    data: { email: "t@example.org", name: "T", passwordHash: "x" },
  });
}

/** Envelhece a substituição do token para além da janela de graça de reuso. */
async function ageOutGrace(rawToken: string) {
  const row = await db.refreshToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!row?.replacedById) throw new Error("token não foi rotacionado");
  await db.refreshToken.update({
    where: { id: row.replacedById },
    data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
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
    await ageOutGrace(first.refreshToken);

    // reuso do token já rotacionado → 401 e família morta
    await expect(tokens.rotate(first.refreshToken)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(tokens.rotate(second.refreshToken)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("reuso dentro da janela de graça renova em vez de matar a sessão", async () => {
    const user = await makeUser();
    const first = await tokens.issue(user.id);
    const second = await tokens.rotate(first.refreshToken);

    // corrida de duas abas: a segunda ainda mandou o cookie antigo
    const third = await tokens.rotate(first.refreshToken);
    expect(third.refreshToken).not.toBe(second.refreshToken);

    // e a família continua viva para os dois lados
    await expect(tokens.rotate(second.refreshToken)).resolves.toMatchObject({
      accessToken: expect.any(String),
    });
  });

  it("rotate de token inexistente falha", async () => {
    await expect(tokens.rotate("nao-existe")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
