import { ValidationError } from "../shared/errors.js";

export type CursorPage<T> = { items: T[]; nextCursor: string | null };

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new ValidationError("invalid_cursor");
  }
  const sep = decoded.indexOf("|");
  if (sep < 1) throw new ValidationError("invalid_cursor");
  const iso = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso || !id) {
    throw new ValidationError("invalid_cursor");
  }
  return { createdAt, id };
}

export function afterCursorWhere(c: { createdAt: Date; id: string }) {
  return { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] };
}

export const KEYSET_ORDER_BY = [{ createdAt: "desc" }, { id: "desc" }] as const;

/**
 * Keyset de preço. Ordenar por preço com o cursor de data repetiria e perderia produto:
 * a chave da ordenação tem de ser a mesma chave do cursor. O prefixo `p|` faz o cursor
 * de uma ordenação ser recusado na outra (data inválida → 400) em vez de misturar páginas.
 */
export function encodePriceCursor(priceCents: number, id: string): string {
  return Buffer.from(`p|${priceCents}|${id}`).toString("base64url");
}

export function decodePriceCursor(cursor: string): { priceCents: number; id: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new ValidationError("invalid_cursor");
  }
  const parts = decoded.split("|");
  if (parts.length !== 3 || parts[0] !== "p") throw new ValidationError("invalid_cursor");
  const priceCents = Number(parts[1]);
  const id = parts[2];
  if (!Number.isInteger(priceCents) || priceCents < 0 || !id) {
    throw new ValidationError("invalid_cursor");
  }
  return { priceCents, id };
}

export function afterPriceCursorWhere(
  c: { priceCents: number; id: string },
  direction: "asc" | "desc",
) {
  const op = direction === "asc" ? "gt" : "lt";
  return {
    OR: [{ priceCents: { [op]: c.priceCents } }, { priceCents: c.priceCents, id: { [op]: c.id } }],
  };
}

export function priceOrderBy(direction: "asc" | "desc") {
  return [{ priceCents: direction }, { id: direction }] as const;
}

export function toPage<Row, T>(
  rows: Row[],
  limit: number,
  cursorOf: (row: Row) => { createdAt: Date; id: string },
  map: (row: Row) => T,
): CursorPage<T> {
  return toPageBy(
    rows,
    limit,
    (row) => {
      const { createdAt, id } = cursorOf(row);
      return encodeCursor(createdAt, id);
    },
    map,
  );
}

/** Mesma paginação, cursor escolhido por quem chama — a ordenação decide a chave. */
export function toPageBy<Row, T>(
  rows: Row[],
  limit: number,
  cursorOf: (row: Row) => string,
  map: (row: Row) => T,
): CursorPage<T> {
  if (limit < 1) throw new ValidationError("invalid_limit");
  const slice = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = slice[slice.length - 1];
  return {
    items: slice.map(map),
    nextCursor: hasMore && last ? cursorOf(last) : null,
  };
}
