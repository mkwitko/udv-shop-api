import type { GoogleGateway } from "../../../../gateways/google/google.gateway.js";
import type { AuthRepository } from "../auth.repository.js";
import type { TokensService } from "../tokens.service.js";

export type GoogleAuthDeps = { repo: AuthRepository; tokens: TokensService; google: GoogleGateway };

export function createGoogleAuthService(deps: GoogleAuthDeps) {
  return async (input: { code: string; nonce: string }): Promise<{ refreshToken: string }> => {
    const profile = await deps.google.exchangeCode(input.code, input.nonce);

    let user = await deps.repo.findUserByGoogleId(profile.sub);
    if (!user) {
      const byEmail = await deps.repo.findUserByEmail(profile.email.toLowerCase());
      if (byEmail) {
        await deps.repo.linkGoogleId(byEmail.id, profile.sub);
        user = byEmail;
      } else {
        user = await deps.repo.createUser({
          email: profile.email.toLowerCase(),
          name: profile.name,
          googleId: profile.sub,
          emailVerified: profile.emailVerified,
        });
      }
    }
    const issued = await deps.tokens.issue(user.id);
    return { refreshToken: issued.refreshToken };
  };
}
