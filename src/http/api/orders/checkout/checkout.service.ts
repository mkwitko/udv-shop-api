import { env } from "../../../../config/env.js";
import type { StripeGateway } from "../../../../gateways/stripe/stripe.gateway.js";
import type { WooviGateway } from "../../../../gateways/woovi/woovi.gateway.js";
import { wooviRetainedFeeCents } from "../../../../lib/provider-fee.js";
import { assertProviderConfigured } from "../../../../lib/store-payments.js";
import { badGateway, NotFoundError, ValidationError } from "../../../../shared/errors.js";
import {
  activeOffer,
  type EventsRepository,
  eventFinished,
} from "../../events/events.repository.js";
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
  events: EventsRepository;
  stripe: StripeGateway;
  woovi: WooviGateway;
};

export function createCheckoutService(deps: CheckoutDeps) {
  return async (
    input: CheckoutBody & { userId: string; contactPhone: string; publicToken: string | null },
  ): Promise<{ order: OrderWithDetails; payment: PaymentInstructions }> => {
    const store = await deps.stores.findBySlug(input.storeSlug);
    if (store?.status !== "active") throw new NotFoundError("store_not_found");
    assertProviderConfigured(store, input.provider);

    // Produto e evento têm espaços de endereço separados, então a chave que não pode
    // repetir no mesmo pedido é o par (tipo, slug) — "cha" produto e "cha" evento convivem.
    const keys = input.items.map((i) => (i.eventSlug ? `e:${i.eventSlug}` : `p:${i.productSlug}`));
    if (new Set(keys).size !== keys.length) throw new ValidationError("duplicate_items");

    const productSlugs = input.items.flatMap((i) => (i.productSlug ? [i.productSlug] : []));
    const eventSlugs = input.items.flatMap((i) => (i.eventSlug ? [i.eventSlug] : []));
    const [products, events] = await Promise.all([
      productSlugs.length > 0
        ? deps.products.findActiveBySlugs(store.id, productSlugs)
        : Promise.resolve([]),
      eventSlugs.length > 0
        ? deps.events.findActiveBySlugs(store.id, eventSlugs)
        : Promise.resolve([]),
    ]);
    const productBySlug = new Map(products.map((p) => [p.slug, p]));
    const eventBySlug = new Map(events.map((e) => [e.slug, e]));

    const items = input.items.map((i) => {
      if (i.eventSlug) {
        const event = eventBySlug.get(i.eventSlug);
        if (!event) throw new NotFoundError("event_not_found");
        // Vaga em evento que já terminou não se vende: o link antigo continua circulando no
        // grupo do WhatsApp muito depois da data, e cobrar por isso é pegar dinheiro por nada.
        if (eventFinished(event)) throw new ValidationError("event_finished");
        // Quem escolhe o lote é o servidor, nunca o cliente: com o lote no corpo do pedido,
        // um link antigo compraria pelo preço do 1º lote depois de ele acabar.
        const offer = activeOffer(event);
        if (event.batches.length > 0 && !offer.batch) {
          throw new ValidationError("event_batch_unavailable");
        }
        const price = offer.priceCents;
        return {
          eventId: event.id,
          ...(offer.batch ? { eventBatchId: offer.batch.id } : {}),
          // o nome carrega o lote porque é o que o recibo tem de dizer: "Oficina — 2º lote"
          name: offer.batch ? `${event.name} — ${offer.batch.name}` : event.name,
          priceCents: price,
          qty: i.qty,
          // o acordo de repasse vale como estava na hora da compra, sobre o preço do lote
          supplierId: event.supplierId,
          payoutCents: itemPayoutCents({ ...event, priceCents: price }, i.qty),
        };
      }
      const product = productBySlug.get(i.productSlug as string);
      if (!product) throw new NotFoundError("product_not_found");
      if (product.availability !== "in_stock") throw new ValidationError("product_not_orderable");
      return {
        productId: product.id,
        name: product.name,
        priceCents: product.priceCents,
        qty: i.qty,
        supplierId: product.supplierId,
        payoutCents: itemPayoutCents(product, i.qty),
      };
    });

    const totalCents = items.reduce((sum, i) => sum + i.priceCents * i.qty, 0);
    // Comissão da plataforma: zero em toda loja (ADR-027). Fica separada da taxa do
    // provedor de propósito — juntar as duas diria para a loja que estamos cobrando
    // comissão quando não estamos.
    const applicationFeeCents = Math.floor((totalCents * store.applicationFeeBps) / 10000);
    // Taxa do provedor (ADR-029). No Pix ela é retida no split agora, porque o split é
    // fixado na criação da cobrança. No cartão ela só existe depois da cobrança aprovada,
    // e quem a grava é o repasse — aqui vai zero, não um palpite.
    const providerFeeCents =
      input.provider === "woovi" ? wooviRetainedFeeCents(totalCents, env.WOOVI_FEE_FIXED_CENTS) : 0;
    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MINUTES * 60 * 1000);

    const order = await deps.orders.createPendingOrder({
      storeId: store.id,
      userId: input.userId,
      provider: input.provider,
      items,
      totalCents,
      applicationFeeCents,
      providerFeeCents,
      contactPhone: input.contactPhone,
      note: input.note ?? null,
      publicToken: input.publicToken,
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
          splitValueCents: totalCents - applicationFeeCents - providerFeeCents,
          comment: `Pedido — ${store.name}`.slice(0, 140),
        });
        await deps.orders.attachProviderId(paymentId, charge.providerId);
        // A cobrança fica gravada: o Pix espera minutos na tela, e um F5 sem isto perdia o QR
        // code e deixava um pendente que ninguém tinha como pagar.
        await deps.orders.attachPixCharge(paymentId, {
          brCode: charge.brCode,
          qrCodeUrl: charge.qrCodeImageUrl,
        });
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
