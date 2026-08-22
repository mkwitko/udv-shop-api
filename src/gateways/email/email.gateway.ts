import { Resend } from "resend";
import { badGateway } from "../../shared/errors.js";

export type EmailGateway = {
  /** `to` aceita lista: um aviso de venda vai para todo mundo que cuida da loja. */
  send(input: { to: string | string[]; subject: string; html: string }): Promise<void>;
};

export function createEmailGateway(cfg: { apiKey: string; from: string }): EmailGateway {
  let resend: Resend | undefined;
  return {
    async send(input) {
      resend ??= new Resend(cfg.apiKey);
      const { error } = await resend.emails.send({
        from: cfg.from,
        to: input.to,
        subject: input.subject,
        html: input.html,
      });
      if (error) throw badGateway("email_send_failed", error);
    },
  };
}
