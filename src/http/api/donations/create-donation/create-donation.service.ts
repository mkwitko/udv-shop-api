import { env } from "../../../../config/env.js";
import type { StripeGateway } from "../../../../gateways/stripe/stripe.gateway.js";
import type { WooviGateway } from "../../../../gateways/woovi/woovi.gateway.js";
import { wooviRetainedFeeCents } from "../../../../lib/provider-fee.js";
import { assertProviderConfigured } from "../../../../lib/store-payments.js";
import { badGateway, NotFoundError, ValidationError } from "../../../../shared/errors.js";
import {
  type CampaignsRepository,
  isCampaignOpenForDonation,
} from "../../campaigns/campaigns.repository.js";
import type { StoresRepository } from "../../stores/stores.repository.js";
import type { DonationsRepository, DonationWithDetails } from "../donations.repository.js";
import type { CreateDonationBody, DonationPaymentInstructions } from "../donations.schema.js";
import { DONATION_TTL_MINUTES } from "../donations.schema.js";

export type CreateDonationDeps = {
  donations: DonationsRepository;
  campaigns: CampaignsRepository;
  stores: StoresRepository;
  stripe: StripeGateway;
  woovi: WooviGateway;
};

export function createDonationService(deps: CreateDonationDeps) {
  return async (
    input: CreateDonationBody & {
      userId: string;
      userEmail: string | null;
      publicToken: string | null;
    },
  ): Promise<{ donation: DonationWithDetails; payment: DonationPaymentInstructions }> => {
    const store = await deps.stores.findBySlug(input.storeSlug);
    if (store?.status !== "active") throw new NotFoundError("store_not_found");
    assertProviderConfigured(store, input.provider);
    // Mensal é só cartão. `POST /api/v1/subscriptions` da Woovi ignora `splits` (testado no
    // sandbox: aceita a chave Pix inexistente e qualquer campo desconhecido, e nada disso
    // volta no GET), então a recorrência cairia na conta da plataforma em vez da subconta
    // de quem organiza. Enquanto não houver rota oficial assinatura → subconta, fica fora.
    if (input.type === "monthly" && input.provider === "woovi") {
      throw new ValidationError("monthly_not_supported_for_provider");
    }
    // A assinatura precisa de e-mail para criar o customer na conta conectada. Recusado antes
    // de gravar a doação: cair nisso depois deixaria um pendente órfão.
    if (input.type === "monthly") requireSubscriberEmail(input.userEmail);

    let campaignId: string | null = null;
    if (input.campaignSlug !== undefined) {
      const campaign = await deps.campaigns.findBySlug(store.id, input.campaignSlug);
      if (!campaign) throw new NotFoundError("campaign_not_found");
      if (!isCampaignOpenForDonation(campaign)) throw new ValidationError("campaign_not_open");
      if (campaign.acceptedTypes !== "both" && campaign.acceptedTypes !== input.type) {
        throw new ValidationError("donation_type_not_accepted");
      }
      campaignId = campaign.id;
    }

    // Comissão da plataforma: zero em toda loja (ADR-027), e separada da taxa do provedor
    // de propósito — juntar as duas diria que estamos cobrando comissão quando não estamos.
    const applicationFeeCents = Math.floor((input.amountCents * store.applicationFeeBps) / 10000);
    // Taxa do provedor (ADR-029). No Pix é retida no split agora, porque o split é fixado
    // na criação da cobrança. No cartão só existe depois da cobrança aprovada, e quem a
    // grava é o repasse — inclusive em cada ciclo da assinatura mensal.
    const providerFeeCents =
      input.provider === "woovi"
        ? wooviRetainedFeeCents(input.amountCents, env.WOOVI_FEE_FIXED_CENTS)
        : 0;
    // Mensal não tem TTL: a assinatura fica incompleta no Stripe até o cartão confirmar.
    const expiresAt =
      input.type === "one_time" ? new Date(Date.now() + DONATION_TTL_MINUTES * 60 * 1000) : null;

    const donation = await deps.donations.createPendingDonation({
      storeId: store.id,
      campaignId,
      userId: input.userId,
      provider: input.provider,
      type: input.type,
      amountCents: input.amountCents,
      applicationFeeCents,
      providerFeeCents,
      anonymous: input.anonymous,
      message: input.message ?? null,
      publicToken: input.publicToken,
      expiresAt,
    });
    const paymentId = donation.payment?.id;
    if (!paymentId) throw new Error("donation_missing_payment");

    let instructions: DonationPaymentInstructions;
    try {
      if (input.type === "monthly") {
        // Destination charge na plataforma, igual à doação única (ver ADR-025).
        const subscription = await deps.stripe.createDonationSubscription({
          amountCents: input.amountCents,
          currency: donation.currency,
          // bps → percentual (500 bps = 5%). Stripe aceita até 2 casas.
          applicationFeePercent: store.applicationFeeBps / 100,
          destinationAccountId: store.stripeAccountId as string,
          // Chamado de novo porque o narrowing da guarda acima não atravessa este bloco.
          customerEmail: requireSubscriberEmail(input.userEmail),
          productName: `Doação mensal — ${store.name}`.slice(0, 140),
          productId: store.stripeDonationProductId,
          metadata: { donationId: donation.id, paymentId },
        });
        if (store.stripeDonationProductId !== subscription.productId) {
          await deps.stores.attachDonationProduct(store.id, subscription.productId);
        }
        await deps.donations.attachProviderId(paymentId, subscription.subscriptionId);
        await deps.donations.attachSubscriptionRef(donation.id, subscription.subscriptionId);
        instructions = {
          provider: "stripe_subscription",
          clientSecret: subscription.clientSecret,
          subscriptionId: subscription.subscriptionId,
        };
      } else if (input.provider === "stripe") {
        const intent = await deps.stripe.createPaymentIntent({
          amountCents: input.amountCents,
          currency: donation.currency,
          metadata: { donationId: donation.id, paymentId },
        });
        await deps.donations.attachProviderId(paymentId, intent.providerId);
        instructions = { provider: "stripe", clientSecret: intent.clientSecret };
      } else {
        const charge = await deps.woovi.createCharge({
          amountCents: input.amountCents,
          correlationID: paymentId,
          expiresInSeconds: DONATION_TTL_MINUTES * 60,
          splitPixKey: store.wooviPixKey as string,
          splitValueCents: input.amountCents - applicationFeeCents - providerFeeCents,
          comment: `Doação — ${store.name}`.slice(0, 140),
        });
        await deps.donations.attachProviderId(paymentId, charge.providerId);
        // A cobrança fica gravada: o Pix espera minutos na tela, e um F5 sem isto perdia o QR
        // code e deixava um pendente que ninguém tinha como pagar.
        await deps.donations.attachPixCharge(paymentId, {
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
      await deps.donations.compensateFailedDonation(donation.id);
      throw badGateway("payment_provider_error", err);
    }
    return { donation, payment: instructions };
  };
}

/**
 * Doação mensal exige e-mail: o Stripe cria um customer na conta conectada, e sem endereço não
 * há recibo nem como a pessoa reconhecer a cobrança. É por isso que a mensal continua pedindo
 * conta enquanto a avulsa aceita só nome e telefone.
 */
function requireSubscriberEmail(email: string | null): string {
  if (!email) throw new ValidationError("email_required_for_monthly");
  return email;
}
