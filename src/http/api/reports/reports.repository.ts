import type { PrismaClient } from "@prisma/client";
import { maskPhone } from "../../../lib/mask.js";
import { PAYOUT_ORDER_STATUSES } from "../payouts/payouts.helpers.js";

export type MonthRow = {
  month: string;
  salesCount: number;
  salesGrossCents: number;
  donationsCount: number;
  donationsGrossCents: number;
  feeCents: number;
  payoutCents: number;
};

export type ExportOrderRow = {
  id: string;
  createdAt: Date;
  status: string;
  totalCents: number;
  contactPhone: string;
  customerName: string;
  /** Nulável: quem compra sem conta pode ter deixado só telefone. */
  customerEmail: string | null;
  items: string;
};

export type ExportInterestRow = {
  createdAt: Date;
  status: string;
  qty: number;
  productName: string;
  customerName: string;
  customerPhone: string | null;
};

export interface ReportsRepository {
  /** Dinheiro por mês, do início do mês `since` para cá. */
  moneyByMonth(storeId: string, since: Date): Promise<MonthRow[]>;
  /** Soma dos saldos de repasse ainda positivos. */
  payoutsOpenCents(storeId: string): Promise<number>;
  exportOrders(storeId: string, limit: number): Promise<ExportOrderRow[]>;
  exportInterests(storeId: string, limit: number): Promise<ExportInterestRow[]>;
}

export function createReportsRepository(db: PrismaClient): ReportsRepository {
  return {
    /**
     * Duas passadas no banco em vez de um join só: somar `order_items` na mesma query
     * dos pagamentos multiplicaria a receita pelo número de itens do pedido.
     */
    moneyByMonth: async (storeId, since) => {
      const money = await db.$queryRaw<
        Array<{
          month: string;
          sales_count: number;
          sales_gross: number;
          donations_count: number;
          donations_gross: number;
          fee: number;
        }>
      >`
        select to_char(date_trunc('month', p.created_at), 'YYYY-MM') as month,
               count(p.order_id)::int as sales_count,
               coalesce(sum(case when p.order_id is not null then p.amount_cents else 0 end), 0)::int as sales_gross,
               count(p.donation_id)::int as donations_count,
               coalesce(sum(case when p.donation_id is not null then p.amount_cents else 0 end), 0)::int as donations_gross,
               coalesce(sum(p.application_fee_cents), 0)::int as fee
          from payments p
          left join orders o on o.id = p.order_id
          left join donations d on d.id = p.donation_id
         where p.status = 'succeeded'
           and coalesce(o.store_id, d.store_id) = ${storeId}::uuid
           and p.created_at >= ${since}
         group by 1
      `;

      const payouts = await db.$queryRaw<Array<{ month: string; payout: number }>>`
        select to_char(date_trunc('month', p.created_at), 'YYYY-MM') as month,
               coalesce(sum(oi.payout_cents), 0)::int as payout
          from payments p
          join orders o on o.id = p.order_id
          join order_items oi on oi.order_id = o.id
         where p.status = 'succeeded'
           and o.store_id = ${storeId}::uuid
           and p.created_at >= ${since}
         group by 1
      `;

      const payoutByMonth = new Map(payouts.map((row) => [row.month, row.payout]));
      return money
        .map((row) => ({
          month: row.month,
          salesCount: row.sales_count,
          salesGrossCents: row.sales_gross,
          donationsCount: row.donations_count,
          donationsGrossCents: row.donations_gross,
          feeCents: row.fee,
          payoutCents: payoutByMonth.get(row.month) ?? 0,
        }))
        .sort((a, b) => (a.month < b.month ? 1 : -1));
    },

    payoutsOpenCents: async (storeId) => {
      const [earned, settled] = await Promise.all([
        db.orderItem.groupBy({
          by: ["supplierId"],
          where: {
            supplierId: { not: null },
            order: { storeId, status: { in: PAYOUT_ORDER_STATUSES } },
          },
          _sum: { payoutCents: true },
        }),
        db.supplierSettlement.groupBy({
          by: ["supplierId"],
          where: { storeId },
          _sum: { amountCents: true },
        }),
      ]);
      const paid = new Map(settled.map((row) => [row.supplierId, row._sum.amountCents ?? 0]));
      // crédito com um parceiro não abate a dívida com outro: só os positivos somam
      return earned.reduce((sum, row) => {
        if (!row.supplierId) return sum;
        const open = (row._sum.payoutCents ?? 0) - (paid.get(row.supplierId) ?? 0);
        return sum + Math.max(0, open);
      }, 0);
    },

    exportOrders: async (storeId, limit) => {
      const rows = await db.order.findMany({
        where: { storeId },
        take: limit,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          createdAt: true,
          status: true,
          totalCents: true,
          contactPhone: true,
          user: { select: { name: true, email: true } },
          items: { select: { name: true, qty: true } },
        },
      });
      return rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        status: row.status,
        totalCents: row.totalCents,
        contactPhone: row.contactPhone,
        customerName: row.user.name,
        customerEmail: row.user.email,
        items: row.items.map((item) => `${item.qty}x ${item.name}`).join(" | "),
      }));
    },

    exportInterests: async (storeId, limit) => {
      const rows = await db.productInterest.findMany({
        where: { product: { storeId } },
        take: limit,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          createdAt: true,
          status: true,
          qty: true,
          product: { select: { name: true } },
          user: { select: { name: true, phone: true } },
        },
      });
      return rows.map((row) => ({
        createdAt: row.createdAt,
        status: row.status,
        qty: row.qty,
        productName: row.product.name,
        customerName: row.user.name,
        // mesma regra da tela: a fila de encomendas nunca entrega o telefone inteiro
        customerPhone: maskPhone(row.user.phone),
      }));
    },
  };
}
