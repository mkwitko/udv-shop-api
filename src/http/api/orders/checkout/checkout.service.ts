import type { Store } from "@prisma/client";
import type { StripeGateway } from "../../../../gateways/stripe/stripe.gateway.js";
import type { WooviGateway } from "../../../../gateways/woovi/woovi.gateway.js";
import { badGateway, NotFoundError, ValidationError } from "../../../../shared/errors.js";
import { itemPayoutCents } from "../../payouts/payouts.helpers.js";
import type { ProductsRepository } from "../../products/products.repository.js";
import type { StoresRepository } from "../../stores/stores.repository.js";
import type { OrdersRepository, OrderWithDetails } from "../orders.repository.js";
import type { CheckoutBody, PaymentInstructions } from "../orders.schema.js";
import { RESERVATION_TTL_MINUTES } from "../orders.schema.js";

export type CheckoutDeps = {
  orders: OrdersRepository;
  stores: StoresRepository;
  products: ProductsRepository;
  stripe: StripeGateway;
  woovi: WooviGateway;
};

export function createCheckoutService(deps: CheckoutDeps) {
  return async (
    input: CheckoutBody & { userId: string },
  ): Promise<{ order: OrderWithDetails; payment: PaymentInstructions }> => {
    const store = await deps.stores.findBySlug(input.storeSlug);
    if (store?.status !== "active") throw new NotFoundError("store_not_found");
    assertProviderConfigured(store, input.provider);

    const slugs = input.items.map((i) => i.productSlug);
    if (new Set(slugs).size !== slugs.length) throw new ValidationError("duplicate_items");
    const products = await deps.products.findActiveBySlugs(store.id, slugs);
    const bySlug = new Map(products.map((p) => [p.slug, p]));

    const items = input.items.map((i) => {
      const product = bySlug.get(i.productSlug);
      if (!product) throw new NotFoundError("product_not_found");
      if (product.availability !== "in_stock") throw new ValidationError("product_not_orderable");
      return {
        productId: product.id,
        name: product.name,
        priceCents: product.priceCents,
        qty: i.qty,
        // o acordo de repasse vale como estava na hora da compra
        supplierId: product.supplierId,
        payoutCents: itemPayoutCents(product, i.qty),
      };
    });

    const totalCents = items.reduce((sum, i) => sum + i.priceCents * i.qty, 0);
    const applicationFeeCents = Math.floor((totalCents * store.applicationFeeBps) / 10000);
    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MINUTES * 60 * 1000);

    const order = await deps.orders.createPendingOrder({
      storeId: store.id,
      userId: input.userId,
      provider: input.provider,
      items,
      totalCents,
      applicationFeeCents,
      contactPhone: input.contactPhone,
      note: input.note ?? null,
      expiresAt,
    });
    const paymentId = order.payment?.id;
    if (!paymentId) throw new Error("checkout_missing_payment");

    let instructions: PaymentInstructions;
    try {
      if (input.provider === "stripe") {
        const intent = await deps.stripe.createPaymentIntent({
          amountCents: totalCents,
          currency: order.currency,
          applicationFeeCents,
          // assertProviderConfigured garante não-nulo
          destinationAccountId: store.stripeAccountId as string,
          metadata: { orderId: order.id, paymentId },
        });
        await deps.orders.attachProviderId(paymentId, intent.providerId);
        instructions = { provider: "stripe", clientSecret: intent.clientSecret };
      } else {
        const charge = await deps.woovi.createCharge({
          amountCents: totalCents,
          correlationID: paymentId,
          expiresInSeconds: RESERVATION_TTL_MINUTES * 60,
          splitPixKey: store.wooviPixKey as string,
          splitValueCents: totalCents - applicationFeeCents,
          comment: `Pedido — ${store.name}`.slice(0, 140),
        });
        await deps.orders.attachProviderId(paymentId, charge.providerId);
        instructions = {
          provider: "woovi",
          brCode: charge.brCode,
          qrCodeImageUrl: charge.qrCodeImageUrl,
          expiresAt: charge.expiresAt,
        };
      }
    } catch (err) {
      await deps.orders.compensateFailedCheckout(order.id);
      throw badGateway("payment_provider_error", err);
    }
    return { order, payment: instructions };
  };
}

function assertProviderConfigured(store: Store, provider: "stripe" | "woovi"): void {
  const configured = provider === "stripe" ? store.stripeAccountId : store.wooviPixKey;
  if (!configured) throw new ValidationError("payments_not_configured");
}
