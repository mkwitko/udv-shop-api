/**
 * CSV para abrir em planilha brasileira: separador `;` e BOM, senão o Excel come os
 * acentos e joga tudo numa coluna só.
 */
const BOM = "﻿";

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? value.toISOString() : String(value);
  // `=`, `+`, `-` e `@` no início são interpretados como fórmula pela planilha
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(cell).join(";"), ...rows.map((row) => row.map(cell).join(";"))];
  return BOM + lines.join("\r\n") + "\r\n";
}

/** Centavos em texto de planilha: vírgula decimal, sem símbolo de moeda. */
export function csvMoney(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

/** `2026-08-18 14:32` no fuso de São Paulo — a loja lê no horário dela. */
export function csvDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}
