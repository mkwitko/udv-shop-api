import { describe, expect, it } from "vitest";
import { csvMoney, toCsv } from "../../src/lib/csv.js";

describe("toCsv", () => {
  it("separa por ponto e vírgula e começa com BOM", () => {
    const csv = toCsv(["A", "B"], [["1", "2"]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("A;B\r\n1;2");
  });

  it("escapa aspas, ponto e vírgula e quebra de linha", () => {
    const csv = toCsv(["Nome"], [['Ana "da" Silva'], ["um; dois"], ["linha\nquebrada"]]);
    expect(csv).toContain('"Ana ""da"" Silva"');
    expect(csv).toContain('"um; dois"');
    expect(csv).toContain('"linha\nquebrada"');
  });

  it("neutraliza célula que a planilha leria como fórmula", () => {
    const csv = toCsv(["X"], [["=1+1"], ["+55 48 99999-0000"], ["@aqui"]]);
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'+55 48 99999-0000");
    expect(csv).toContain("'@aqui");
  });

  it("célula vazia para null e undefined", () => {
    expect(toCsv(["A", "B"], [[null, undefined]])).toContain("A;B\r\n;\r\n");
  });
});

describe("csvMoney", () => {
  it("centavos viram número com vírgula decimal", () => {
    expect(csvMoney(10000)).toBe("100,00");
    expect(csvMoney(4450)).toBe("44,50");
    expect(csvMoney(0)).toBe("0,00");
  });
});
