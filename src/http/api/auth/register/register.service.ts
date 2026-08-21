import { randomBytes } from "node:crypto";
import type { EmailGateway } from "../../../../gateways/email/email.gateway.js";
import { logger } from "../../../../infra/observability/logger.js";
import { hashPassword } from "../../../../lib/password.js";
import { ConflictError } from "../../../../shared/errors.js";
import type { AuthRepository } from "../auth.repository.js";
import { type AuthResult, toPublicUser } from "../auth.types.js";
import { verifyEmailHtml } from "../emails.js";
import { hashToken, type TokensService } from "../tokens.service.js";
import type { RegisterBody } from "./register.schema.js";

export type RegisterDeps = { repo: AuthRepository; tokens: TokensService; email: EmailGateway };

export function createRegisterService(deps: RegisterDeps) {
  return async (input: RegisterBody): Promise<AuthResult> => {
    const existing = await deps.repo.findUserByEmail(input.email);
    if (existing) throw new ConflictError("email_in_use");

    const user = await deps.repo.createUser({
      email: input.email,
      name: input.name,
      passwordHash: await hashPassword(input.password),
    });

    const rawToken = randomBytes(32).toString("base64url");
    await deps.repo.insertEmailToken({
      userId: user.id,
      type: "verify_email",
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const { subject, html } = verifyEmailHtml(user.name, rawToken);
    try {
      await deps.email.send({ to: input.email, subject, html });
    } catch (err) {
      // registro não falha por email; usuário pode pedir reenvio depois
      logger.warn({ err, userId: user.id }, "verify email send failed");
    }

    const issued = await deps.tokens.issue(user.id);
    return { ...issued, user: toPublicUser(user) };
  };
}
