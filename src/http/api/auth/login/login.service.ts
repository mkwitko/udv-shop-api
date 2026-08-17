import { verifyPassword } from "../../../../lib/password.js";
import { UnauthorizedError } from "../../../../shared/errors.js";
import type { AuthRepository } from "../auth.repository.js";
import { toPublicUser, type AuthResult } from "../auth.types.js";
import type { TokensService } from "../tokens.service.js";
import type { LoginBody } from "./login.schema.js";

export function createLoginService(deps: { repo: AuthRepository; tokens: TokensService }) {
  return async (input: LoginBody): Promise<AuthResult> => {
    const user = await deps.repo.findUserByEmail(input.email);
    // mensagem idêntica p/ email inexistente e senha errada (não vaza existência)
    if (!user?.passwordHash) throw new UnauthorizedError("invalid_credentials");
    const ok = await verifyPassword(user.passwordHash, input.password);
    if (!ok) throw new UnauthorizedError("invalid_credentials");
    const issued = await deps.tokens.issue(user.id);
    return { ...issued, user: toPublicUser(user) };
  };
}
