import { UnauthorizedError } from "../../../../shared/errors.js";
import type { AuthRepository } from "../auth.repository.js";
import { hashToken } from "../tokens.service.js";

export function createVerifyEmailService(deps: { repo: AuthRepository }) {
  return async (input: { token: string }): Promise<void> => {
    const row = await deps.repo.findEmailTokenByHash(hashToken(input.token));
    if (!row || row.type !== "verify_email" || row.usedAt || row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedError("invalid_token");
    }
    await deps.repo.markEmailVerified(row.userId);
    await deps.repo.markEmailTokenUsed(row.id);
  };
}
