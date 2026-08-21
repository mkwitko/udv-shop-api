import type { FastifyRequest } from "fastify";
import type { TurnstileGateway } from "../../gateways/turnstile/turnstile.gateway.js";
import { ValidationError } from "../../shared/errors.js";

/**
 * Exige o desafio nas escritas sem conta, quando a plataforma tem Turnstile configurado. Quem
 * chega com sessão não passa por aqui: já se cadastrou, e o desafio existe para conter criação
 * de conta leve em massa, não para atrapalhar quem já é cliente.
 */
export async function assertHumanIfGuest(
  turnstile: TurnstileGateway,
  req: FastifyRequest,
  captchaToken: string | undefined,
): Promise<void> {
  if (!turnstile.enabled) return;
  if (req.user) return;
  if (!captchaToken) throw new ValidationError("captcha_required");
  const ok = await turnstile.verify({ token: captchaToken, ip: req.ip });
  if (!ok) throw new ValidationError("captcha_failed");
}
