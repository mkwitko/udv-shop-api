/**
 * Quanto a plataforma retém do split da Woovi para cobrir a taxa do Pix.
 *
 * A taxa da Woovi é fixa por transação (R$ 0,85 de contrato) e é debitada da conta master.
 * Como o split é definido na CRIAÇÃO da cobrança e o saque da subconta só leva o saldo
 * inteiro, retê-la aqui é a única forma de a taxa ser da loja e não da plataforma (ADR-029).
 *
 * Dois limites, os dois por causa da Woovi e não por gosto:
 * - teto em `amountCents - 1`: split igual ao valor da cobrança é recusado com
 *   `400 "O valor total do split de pagamento não pode ser igual ao valor da cobrança"`.
 *   Numa cobrança menor que a taxa a plataforma absorve a diferença — é dinheiro limitado
 *   (Pix de menos de um real) e recusar a venda custaria mais.
 * - piso de 1 centavo: com a taxa configurada em zero o split nasceria com 100% do valor e
 *   nenhuma cobrança Pix seria criada.
 */
export function wooviRetainedFeeCents(amountCents: number, feeCents: number): number {
  return Math.min(Math.max(feeCents, 1), amountCents - 1);
}
