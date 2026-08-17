import { describe, expect, it } from "vitest";
import { afterCursorWhere, decodeCursor, encodeCursor, toPage } from "../../src/lib/cursor.js";

describe("cursor", () => {
  const d = new Date("2026-08-17T12:00:00.000Z");

  it("encode/decode roundtrip", () => {
    const c = encodeCursor(d, "abc-123");
    expect(decodeCursor(c)).toEqual({ createdAt: d, id: "abc-123" });
  });

  it("decode rejeita lixo", () => {
    expect(() => decodeCursor("n@o-base64url!!")).toThrow();
    expect(() => decodeCursor(Buffer.from("sem-pipe").toString("base64url"))).toThrow();
    expect(() => decodeCursor(Buffer.from("data-invalida|id").toString("base64url"))).toThrow();
  });

  it("afterCursorWhere gera OR keyset", () => {
    expect(afterCursorWhere({ createdAt: d, id: "x" })).toEqual({
      OR: [{ createdAt: { lt: d } }, { createdAt: d, id: { lt: "x" } }],
    });
  });

  it("toPage corta em limit e deriva nextCursor da última linha exibida", () => {
    const rows = [
      { createdAt: d, id: "3", v: "c" },
      { createdAt: d, id: "2", v: "b" },
      { createdAt: d, id: "1", v: "a" },
    ];
    const page = toPage(
      rows,
      2,
      (r) => ({ createdAt: r.createdAt, id: r.id }),
      (r) => r.v,
    );
    expect(page.items).toEqual(["c", "b"]);
    expect(page.nextCursor).toBe(encodeCursor(d, "2"));
  });

  it("toPage sem página seguinte → nextCursor null", () => {
    const rows = [{ createdAt: d, id: "1", v: "a" }];
    const page = toPage(
      rows,
      2,
      (r) => ({ createdAt: r.createdAt, id: r.id }),
      (r) => r.v,
    );
    expect(page).toEqual({ items: ["a"], nextCursor: null });
  });

  it("toPage rejeita limit < 1", () => {
    expect(() =>
      toPage(
        [],
        0,
        () => ({ createdAt: d, id: "x" }),
        (r) => r,
      ),
    ).toThrow();
  });
});
