import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { env } from "../../config/env.js";
import { createEmailGateway } from "../../gateways/email/email.gateway.js";
import { createGoogleGateway } from "../../gateways/google/google.gateway.js";
import { createR2Gateway } from "../../gateways/r2/r2.gateway.js";
import { createStripeGateway } from "../../gateways/stripe/stripe.gateway.js";
import { createFakeWooviGateway } from "../../gateways/woovi/woovi.fake.js";
import { createWooviGateway } from "../../gateways/woovi/woovi.gateway.js";
import type { Gateways } from "../../types/fastify.js";

export function buildDefaultGateways(): Gateways {
  return {
    email: createEmailGateway({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM }),
    google: createGoogleGateway({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: env.GOOGLE_REDIRECT_URI,
    }),
    r2: createR2Gateway({
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET,
      publicBaseUrl: env.R2_PUBLIC_BASE_URL,
    }),
    stripe: createStripeGateway({
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      connectCountry: env.STRIPE_CONNECT_COUNTRY,
    }),
    // demo local sem credenciais: Pix falso que se autoconfirma (proibido em produção)
    woovi: env.DEV_FAKE_PAYMENTS
      ? createFakeWooviGateway()
      : createWooviGateway({
          apiKey: env.WOOVI_API_KEY,
          webhookHmacSecret: env.WOOVI_WEBHOOK_HMAC_SECRET,
        }),
  };
}

const _plugin: FastifyPluginAsync<{ gateways?: Gateways | undefined }> = async (app, opts) => {
  app.decorate("gateways", opts.gateways ?? buildDefaultGateways());
};

export const gatewaysPlugin = fp(_plugin, { name: "gateways" });
