import type { OrderStatus, PayoutKind } from "@prisma/client";
import { ValidationError } from "../../../shared/errors.js";

/**
 * Pedido que já entrou dinheiro conta para o repasse. `pending_payment` ainda pode
 * expirar, `cancelled` e `refunded` não geraram receita — ficam fora da soma. Um
 * reembolso depois do repasse pago derruba o saldo para negativo, e é assim que a
 * loja vê que tem crédito com o parceiro.
 */
export const PAYOUT_ORDER_STATUSES: OrderStatus[] = ["paid", "delivery_arranged", "delivered"];

export type PayoutAgreement = {
  priceCents: number;
  payoutKind: PayoutKind | null;
  payoutValue: number | null;
};

/** Quanto vai para o parceiro em uma unidade vendida. */
export function unitPayoutCents(product: PayoutAgreement): number {
  if (product.payoutKind === null || product.payoutValue === null) return 0;
  if (product.payoutKind === "fixed_cents")
    return Math.min(product.payoutValue, product.priceCents);
  return Math.floor((product.priceCents * product.payoutValue) / 10000);
}

/** Repasse congelado no item do pedido, já multiplicado pela quantidade. */
export function itemPayoutCents(product: PayoutAgreement, qty: number): number {
  return unitPayoutCents(product) * qty;
}

/**
 * A taxa da plataforma sai antes de tudo: prometer ao parceiro mais do que sobra
 * depois dela é a loja pagando para vender. Barra na entrada, com o número na mão.
 */
export function assertPayoutFits(product: PayoutAgreement, applicationFeeBps: number): void {
  const payout = unitPayoutCents(product);
  if (payout === 0) return;
  const feeCents = Math.floor((product.priceCents * applicationFeeBps) / 10000);
  if (payout > product.priceCents - feeCents) throw new ValidationError("payout_exceeds_price");
}

/**
 * Um acordo de repasse é um trio: sem parceiro não há para quem repassar, sem regra
 * não há quanto. Meio acordo salvo é saldo errado depois.
 */
export function normalizePayoutFields(input: {
  supplierId?: string | null | undefined;
  payoutKind?: PayoutKind | null | undefined;
  payoutValue?: number | null | undefined;
}): { supplierId: string | null; payoutKind: PayoutKind | null; payoutValue: number | null } {
  const supplierId = input.supplierId ?? null;
  const payoutKind = input.payoutKind ?? null;
  const payoutValue = input.payoutValue ?? null;
  const filled = [supplierId, payoutKind, payoutValue].filter((v) => v !== null).length;
  if (filled !== 0 && filled !== 3) throw new ValidationError("payout_incomplete");
  if (payoutKind === "percent_bps" && payoutValue !== null && payoutValue > 10000) {
    throw new ValidationError("payout_percent_out_of_range");
  }
  return { supplierId, payoutKind, payoutValue };
}
