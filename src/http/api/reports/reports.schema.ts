import { z } from "zod";

const MonthMoney = z.object({
  /** "2026-08" */
  month: z.string(),
  salesCount: z.number().int(),
  salesGrossCents: z.number().int(),
  donationsCount: z.number().int(),
  donationsGrossCents: z.number().int(),
  feeCents: z.number().int(),
  payoutCents: z.number().int(),
  /** Entrou menos taxa menos repasse: o que sobra para a loja. */
  netCents: z.number().int(),
});

export const StatementResponse = z.object({
  months: z.array(MonthMoney),
  totals: MonthMoney.omit({ month: true }),
  /** Saldo de repasse ainda em aberto hoje, para fechar a conta com a aba Repasses. */
  payoutsOpenCents: z.number().int(),
});

export const StatementQuery = z.object({
  months: z.coerce.number().int().min(1).max(24).default(6),
});
export type StatementQuery = z.infer<typeof StatementQuery>;

export const ExportQuery = z.object({
  /** Quantidade máxima de linhas; teto para não gerar arquivo sem fim. */
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});
export type ExportQuery = z.infer<typeof ExportQuery>;
