import { randomBytes } from "node:crypto";
import type { EmailGateway } from "../../../../gateways/email/email.gateway.js";
import { logger } from "../../../../infra/observability/logger.js";
import type { AuthRepository } from "../auth.repository.js";
import { resetPasswordHtml } from "../emails.js";
import { hashToken } from "../tokens.service.js";
import type { ForgotPasswordBody } from "./forgot-password.schema.js";

export function createForgotPasswordService(deps: { repo: AuthRepository; email: EmailGateway }) {
  return async (input: ForgotPasswordBody): Promise<void> => {
    const user = await deps.repo.findUserByEmail(input.email);
    if (!user) return; // 204 sempre — não vaza existência de conta
    const raw = randomBytes(32).toString("base64url");
    await deps.repo.insertEmailToken({
      userId: user.id,
      type: "password_reset",
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const { subject, html } = resetPasswordHtml(user.name, raw);
    try {
      await deps.email.send({ to: user.email, subject, html });
    } catch (err) {
      logger.warn({ err, userId: user.id }, "reset email send failed");
    }
  };
}
