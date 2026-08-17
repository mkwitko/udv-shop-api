import type { GoogleGateway } from "../../../../gateways/google/google.gateway.js";
import { UnauthorizedError } from "../../../../shared/errors.js";
import type { AuthRepository } from "../auth.repository.js";
import type { TokensService } from "../tokens.service.js";

export type GoogleAuthDeps = { repo: AuthRepository; tokens: TokensService; google: GoogleGateway };

export function createGoogleAuthService(deps: GoogleAuthDeps) {
  return async (input: { code: string; nonce: string }): Promise<{ refreshToken: string }> => {
    const profile = await deps.google.exchangeCode(input.code, input.nonce);
    // defense in depth: the gateway already rejects an empty email, but a fake/alternate
    // gateway implementation (e.g. in tests) could still hand one back here.
    if (!profile.email) throw new UnauthorizedError("google_email_missing");

    let user = await deps.repo.findUserByGoogleId(profile.sub);
    if (!user) {
      // an unverified email must never be trusted to link to (or create) an account:
      // otherwise anyone can claim a victim's email at Google and take over their account.
      if (!profile.emailVerified) throw new UnauthorizedError("google_email_not_verified");
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
