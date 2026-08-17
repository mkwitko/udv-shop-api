/**
 * Escapa texto vindo do banco antes de interpolar em HTML de email. Nomes de usuário,
 * de produto e títulos de campanha/prêmio são digitados por gente — sem isto, um título
 * com `<` quebra o layout do email e um `<a>` injetado vira link de phishing assinado
 * pelo nosso remetente.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
