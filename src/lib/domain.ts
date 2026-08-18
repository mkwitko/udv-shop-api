/**
 * Domínio próprio de loja. A pessoa vai colar "https://Loja.Exemplo.org/" ou
 * "www.loja.exemplo.org." — tudo isso é o mesmo endereço, e precisa virar uma forma
 * canônica antes de encostar no banco, senão o `@unique` não segura duplicata.
 */
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (value === "") return null;
  value = value.replace(/^https?:\/\//, "");
  value = value.replace(/\/.*$/, "");
  value = value.replace(/:\d+$/, "");
  value = value.replace(/\.$/, "");
  if (value.length > 253) return null;
  const labels = value.split(".");
  // exige pelo menos um ponto: "localhost" ou "loja" não são endereços públicos
  if (labels.length < 2) return null;
  if (!labels.every((label) => LABEL.test(label))) return null;
  // TLD não pode ser só número (evita IP disfarçado)
  const tld = labels.at(-1) as string;
  if (/^\d+$/.test(tld)) return null;
  return value;
}

/** `loja.exemplo.org` está dentro de `exemplo.org`? Também vale para o próprio. */
export function isSameOrSubdomain(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.endsWith(`.${parent}`);
}

/**
 * O host de uma URL, sem porta. Usado para descobrir o domínio da plataforma a partir
 * de `WEB_ORIGIN` — a loja não pode reivindicar o endereço da própria plataforma.
 */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
