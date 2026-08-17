import { env } from "../../../config/env.js";

export function verifyEmailHtml(name: string, token: string): { subject: string; html: string } {
  const url = `${env.WEB_ORIGIN}/verificar-email?token=${token}`;
  return {
    subject: "Confirme seu email",
    html: `<p>Olá, ${name}!</p><p>Que bom ter você com a gente. Confirme seu email clicando no link abaixo:</p><p><a href="${url}">Confirmar email</a></p><p>Se você não criou esta conta, pode ignorar esta mensagem.</p>`,
  };
}

export function resetPasswordHtml(name: string, token: string): { subject: string; html: string } {
  const url = `${env.WEB_ORIGIN}/redefinir-senha?token=${token}`;
  return {
    subject: "Redefinição de senha",
    html: `<p>Olá, ${name}.</p><p>Recebemos um pedido para redefinir sua senha. O link vale por 1 hora:</p><p><a href="${url}">Redefinir senha</a></p><p>Se não foi você, nenhuma ação é necessária.</p>`,
  };
}
