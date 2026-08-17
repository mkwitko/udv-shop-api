import { env } from "../../../config/env.js";

// user-provided values (e.g. the display name) must never be interpolated into HTML
// unescaped — otherwise a name like `<img src=x onerror=...>` gets executed by the
// recipient's mail client.
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function verifyEmailHtml(name: string, token: string): { subject: string; html: string } {
  const url = `${env.WEB_ORIGIN}/verificar-email?token=${token}`;
  const safeName = escapeHtml(name);
  return {
    subject: "Confirme seu email",
    html: `<p>Olá, ${safeName}!</p><p>Que bom ter você com a gente. Confirme seu email clicando no link abaixo:</p><p><a href="${url}">Confirmar email</a></p><p>Se você não criou esta conta, pode ignorar esta mensagem.</p>`,
  };
}

export function resetPasswordHtml(name: string, token: string): { subject: string; html: string } {
  const url = `${env.WEB_ORIGIN}/redefinir-senha?token=${token}`;
  const safeName = escapeHtml(name);
  return {
    subject: "Redefinição de senha",
    html: `<p>Olá, ${safeName}.</p><p>Recebemos um pedido para redefinir sua senha. O link vale por 1 hora:</p><p><a href="${url}">Redefinir senha</a></p><p>Se não foi você, nenhuma ação é necessária.</p>`,
  };
}
