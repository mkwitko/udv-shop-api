import { env } from "../../../../config/env.js";
import { escapeHtml } from "../../../../lib/html.js";

const ROLE_LABEL: Record<string, string> = {
  admin: "administrar",
  staff: "ajudar na operação",
};

export function inviteEmailHtml(input: { storeName: string; role: string; token: string }): {
  subject: string;
  html: string;
} {
  const url = `${env.WEB_ORIGIN}/convite/${input.token}`;
  const store = escapeHtml(input.storeName);
  const doing = ROLE_LABEL[input.role] ?? input.role;
  return {
    subject: `Convite para cuidar da loja ${input.storeName}`,
    html: `<p>Você foi convidado(a) para ${doing} a loja <strong>${store}</strong> na Colheita.</p><p>O convite vale por 7 dias:</p><p><a href="${url}">Aceitar convite</a></p><p>Se você não esperava este convite, pode ignorar esta mensagem.</p>`,
  };
}
