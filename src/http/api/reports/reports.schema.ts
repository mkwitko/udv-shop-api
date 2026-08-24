import { z } from "zod";

const MonthMoney = z.object({
  /** "2026-08" */
  month: z.string(),
  salesCount: z.number().int(),
  salesGrossCents: z.number().int(),
  donationsCount: z.number().int(),
  donationsGrossCents: z.number().int(),
  /** Comissão da plataforma sobre a venda. Zero: o modelo é mensalidade (ADR-027). */
  feeCents: z.number().int(),
  /** Taxa que Stripe/Woovi cobraram, descontada do repasse da loja (ADR-029). */
  providerFeeCents: z.number().int(),
  payoutCents: z.number().int(),
  /** Entrou menos as taxas menos repasse: o que sobra para a loja. */
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
