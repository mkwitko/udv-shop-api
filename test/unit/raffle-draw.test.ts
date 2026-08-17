import { describe, expect, it } from "vitest";
import { drawWinners } from "../../src/http/api/raffles/draw.js";

const NUMBERS = Array.from({ length: 50 }, (_, i) => i + 1);

describe("drawWinners", () => {
  it("é determinístico: mesma seed e mesmo pool → mesmo resultado", () => {
    expect(drawWinners("seed-abc", NUMBERS, 3)).toEqual(drawWinners("seed-abc", NUMBERS, 3));
  });

  it("seeds diferentes dão resultados diferentes", () => {
    expect(drawWinners("seed-abc", NUMBERS, 3)).not.toEqual(drawWinners("seed-xyz", NUMBERS, 3));
  });

  it("não repete vencedor entre prêmios", () => {
    const winners = drawWinners("seed-abc", NUMBERS, 10);
    expect(new Set(winners).size).toBe(10);
  });

  it("a ordem de entrada não muda o resultado (pool é ordenado internamente)", () => {
    const shuffled = [...NUMBERS].reverse();
    expect(drawWinners("seed-abc", shuffled, 5)).toEqual(drawWinners("seed-abc", NUMBERS, 5));
  });

  it("pool menor que a quantidade de prêmios devolve só o que dá", () => {
    expect(drawWinners("seed-abc", [7, 9], 5)).toHaveLength(2);
  });

  it("pool vazio devolve lista vazia", () => {
    expect(drawWinners("seed-abc", [], 3)).toEqual([]);
  });
});
