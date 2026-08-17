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

export function toPage<Row, T>(
  rows: Row[],
  limit: number,
  cursorOf: (row: Row) => { createdAt: Date; id: string },
  map: (row: Row) => T,
): CursorPage<T> {
  if (limit < 1) throw new ValidationError("invalid_limit");
  const slice = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = slice[slice.length - 1];
  return {
    items: slice.map(map),
    nextCursor:
      hasMore && last ? (({ createdAt, id }) => encodeCursor(createdAt, id))(cursorOf(last)) : null,
  };
}
