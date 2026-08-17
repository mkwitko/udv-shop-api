import { hashPassword } from "../../../../lib/password.js";
import { UnauthorizedError } from "../../../../shared/errors.js";
import type { AuthRepository } from "../auth.repository.js";
import { hashToken, type TokensService } from "../tokens.service.js";
import type { ResetPasswordBody } from "./reset-password.schema.js";

export function createResetPasswordService(deps: { repo: AuthRepository; tokens: TokensService }) {
  return async (input: ResetPasswordBody): Promise<void> => {
    const row = await deps.repo.findEmailTokenByHash(hashToken(input.token));
    if (!row || row.type !== "password_reset" || row.usedAt || row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedError("invalid_token");
    }
    await deps.repo.setPassword(row.userId, await hashPassword(input.password));
    await deps.repo.markEmailTokenUsed(row.id);
    await deps.tokens.revokeAllForUser(row.userId);
  };
}
