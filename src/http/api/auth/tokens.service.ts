import { createHash, randomBytes, randomUUID } from "node:crypto";
import { env } from "../../../config/env.js";
import { signAccessToken } from "../../../lib/jwt.js";
import { UnauthorizedError } from "../../../shared/errors.js";
import type { AuthRepository } from "./auth.repository.js";

export type TokensServiceDeps = { repo: AuthRepository };

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function createTokensService(deps: TokensServiceDeps) {
  const refreshTtlMs = env.REFRESH_TOKEN_TTL_D * 24 * 60 * 60 * 1000;

  async function buildAccess(userId: string): Promise<string> {
    const user = await deps.repo.findUserById(userId);
    if (!user) throw new UnauthorizedError("user_not_found");
    const roles = await deps.repo.userRoles(userId);
    return signAccessToken({ id: user.id, platformAdmin: user.platformAdmin, roles });
  }

  async function mint(userId: string, familyId: string) {
    const raw = randomBytes(48).toString("base64url");
    const row = await deps.repo.insertRefreshToken({
      userId,
      familyId,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + refreshTtlMs),
    });
    return { raw, row };
  }

  return {
    async issue(userId: string) {
      const { raw } = await mint(userId, randomUUID());
      return { accessToken: await buildAccess(userId), refreshToken: raw };
    },

    async rotate(rawToken: string) {
      const row = await deps.repo.findRefreshTokenByHash(hashToken(rawToken));
      if (!row) throw new UnauthorizedError("invalid_refresh_token");
      if (row.revokedAt) throw new UnauthorizedError("refresh_token_revoked");
      if (row.replacedById) {
        // reuse detection: token já rotacionado sendo reapresentado → família comprometida
        await deps.repo.revokeFamily(row.familyId);
        throw new UnauthorizedError("refresh_token_reused");
      }
      if (row.expiresAt.getTime() < Date.now()) {
        throw new UnauthorizedError("refresh_token_expired");
      }
      const { raw, row: next } = await mint(row.userId, row.familyId);
      await deps.repo.markReplaced(row.id, next.id);
      return { accessToken: await buildAccess(row.userId), refreshToken: raw };
    },

    async revokeFamilyByToken(rawToken: string) {
      const row = await deps.repo.findRefreshTokenByHash(hashToken(rawToken));
      if (row) await deps.repo.revokeFamily(row.familyId);
    },

    async revokeAllForUser(userId: string) {
      await deps.repo.revokeAllForUser(userId);
    },
  };
}

export type TokensService = ReturnType<typeof createTokensService>;
