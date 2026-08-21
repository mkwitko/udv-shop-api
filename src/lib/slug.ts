import { ValidationError } from "../shared/errors.js";

/**
 * Nome digitado → slug de URL. Roda no servidor porque quem escreve "Chás e Ervas" não
 * deveria ter de pensar em endereço, e porque slug vindo do cliente é entrada a validar.
 */
export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/**
 * Slug livre dentro da loja. "Chás" duas vezes vira `chas` e `chas-2` — a segunda
 * categoria não pode roubar o endereço da primeira nem falhar na cara de quem cadastrou.
 */
export function uniqueSlug(base: string, taken: Set<string>): string {
  const slug = slugify(base);
  if (!slug) throw new ValidationError("slug_empty");
  if (!taken.has(slug)) return slug;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${slug}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new ValidationError("slug_exhausted");
}
