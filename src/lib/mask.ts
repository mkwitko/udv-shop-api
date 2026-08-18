/**
 * Telefone parcial para listas de gestão: a loja reconhece quem é sem que a tela
 * carregue o número inteiro. O contato completo sai só na ação de falar com a pessoa.
 * "5548999995678" → "(48) ****-5678"; entrada curta demais vira null.
 */
export function maskPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length >= 12) digits = digits.slice(2);
  if (digits.length < 8) return null;
  const ddd = digits.length >= 10 ? digits.slice(0, 2) : null;
  const last4 = digits.slice(-4);
  return ddd ? `(${ddd}) ****-${last4}` : `****-${last4}`;
}
