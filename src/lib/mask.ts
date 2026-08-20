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

/**
 * Chave Pix parcial para a tela de recebimento. A loja precisa reconhecer QUAL chave
 * está salva (sem isso a tela mente por omissão: diz "ligado" e não diz ligado em quê),
 * mas a chave inteira é dado pessoal do núcleo e não precisa trafegar a cada render.
 *
 * "maria@gmail.com" → "ma***@gmail.com"; "5548999995678" → "(48) ****-5678";
 * CPF/CNPJ → só os 4 últimos dígitos; chave aleatória → começo…fim.
 */
export function maskPixKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim();
  if (!key) return null;

  const at = key.indexOf("@");
  if (at > 0) {
    const local = key.slice(0, at);
    const domain = key.slice(at);
    const head = local.slice(0, Math.min(2, local.length));
    return `${head}***${domain}`;
  }

  const digits = key.replace(/\D/g, "");
  const onlyPhoneChars = digits.length === key.replace(/[\s()+-]/g, "").length;
  // CPF tem 11 dígitos, igual a celular com DDD: o que desempata é o +55 da chave de
  // telefone. Sem esse critério, CPF virava "(12) ****-8901".
  const looksLikePhone =
    onlyPhoneChars && (key.startsWith("+") || (digits.startsWith("55") && digits.length >= 12));
  if (looksLikePhone) return maskPhone(key) ?? `****${digits.slice(-4)}`;
  // CPF (11) e CNPJ (14) chegam só com dígitos
  if (digits.length === key.length && (digits.length === 11 || digits.length === 14)) {
    return `${"•".repeat(digits.length - 4)}${digits.slice(-4)}`;
  }
  if (onlyPhoneChars && digits.length >= 10 && digits.length <= 13) {
    return maskPhone(key) ?? `****${digits.slice(-4)}`;
  }

  if (key.length <= 8) return `${key.slice(0, 1)}***${key.slice(-1)}`;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
