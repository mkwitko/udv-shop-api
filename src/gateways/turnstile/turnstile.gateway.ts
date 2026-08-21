import { logger } from "../../infra/observability/logger.js";

export type TurnstileGateway = {
  /**
   * Ligado só quando há segredo configurado. Sem isso as rotas públicas seguem abertas: o
   * limite por IP continua sendo a primeira linha, e exigir um desafio que a plataforma não
   * sabe validar barraria todo mundo.
   */
  readonly enabled: boolean;
  verify(input: { token: string; ip?: string | undefined }): Promise<boolean>;
};

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function createTurnstileGateway(config: { secretKey: string }): TurnstileGateway {
  const secretKey = config.secretKey.trim();
  return {
    enabled: secretKey !== "",
    verify: async ({ token, ip }) => {
      if (secretKey === "") return true;
      const body = new URLSearchParams({ secret: secretKey, response: token });
      if (ip) body.set("remoteip", ip);
      try {
        const res = await fetch(VERIFY_URL, { method: "POST", body });
        const json = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
        if (!json.success) {
          logger.info({ codes: json["error-codes"] }, "turnstile: desafio recusado");
        }
        return json.success === true;
      } catch (err) {
        // Cloudflare fora do ar não pode fechar a loja: o desafio é defesa contra abuso em
        // massa, não controle de acesso. O limite por IP continua valendo.
        logger.warn({ err }, "turnstile indisponível: seguindo sem o desafio");
        return true;
      }
    },
  };
}
