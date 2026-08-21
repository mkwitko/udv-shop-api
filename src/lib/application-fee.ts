/**
 * Comissão efetivamente retida pela plataforma numa cobrança Woovi.
 *
 * A Woovi recusa split cujo valor iguale o da cobrança — `400 "O valor total do split
 * de pagamento não pode ser igual ao valor da cobrança"`. Como a plataforma vive de
 * mensalidade e não de comissão, `applicationFeeBps` é 0 em todas as lojas: sem esse
 * piso o split nasceria com 100% do valor e nenhuma cobrança Pix seria criada.
 *
 * O valor devolvido é o que vai tanto para o split quanto para o registro no banco —
 * gravar 0 e reter 1 centavo deixaria o extrato da loja furado no mesmo centavo.
 *
 * Só vale para Woovi. O Stripe aceita `application_fee_amount` zerado.
 */
export function wooviApplicationFeeCents(amountCents: number, feeCents: number): number {
  return Math.min(Math.max(feeCents, 1), amountCents - 1);
}
