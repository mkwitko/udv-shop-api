import type { PayoutKind } from "@prisma/client";
import { db } from "../../../infra/db/client.js";
import { ValidationError } from "../../../shared/errors.js";
import { assertPayoutFits, normalizePayoutFields } from "../payouts/payouts.helpers.js";
import { createPayoutsRepository } from "../payouts/payouts.repository.js";

type PayoutInput = {
  supplierId?: string | null | undefined;
  payoutKind?: PayoutKind | null | undefined;
  payoutValue?: number | null | undefined;
};

/**
 * Valida o acordo de repasse que vai ficar valendo — não só o que o formulário mandou.
 * Baixar o preço de um produto que já tem repasse combinado pode virar prejuízo, então
 * a checagem sempre roda com o trio efetivo e o preço efetivo.
 */
export async function assertPayoutForStore(
  store: { id: string; applicationFeeBps: number },
  effective: PayoutInput & { priceCents: number },
): Promise<void> {
  const { supplierId, payoutKind, payoutValue } = normalizePayoutFields(effective);
  if (supplierId === null) return;

  const supplier = await createPayoutsRepository(db).findSupplier(store.id, supplierId);
  if (!supplier) throw new ValidationError("supplier_not_found");
  if (!supplier.active) throw new ValidationError("supplier_inactive");

  assertPayoutFits(
    { priceCents: effective.priceCents, payoutKind, payoutValue },
    store.applicationFeeBps,
  );
}
