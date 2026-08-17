import { z } from "zod";

// keep in sync with the placeholder shipped in .env.example — that value must never reach a
// running production process.
const COOKIE_SECRET_PLACEHOLDER = "troque-por-32-bytes-aleatorios";

const BaseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3333),
  DATABASE_URL: z.string().min(1),
  WEB_ORIGIN: z.string().url(),
  TRUST_PROXY_HOPS: z.coerce.number().default(1),
  JWT_PRIVATE_KEY_B64: z.string().min(1),
  JWT_PUBLIC_KEY_B64: z.string().min(1),
  ACCESS_TOKEN_TTL_S: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_D: z.coerce.number().default(30),
  COOKIE_SECRET: z.string().min(16),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_REDIRECT_URI: z.string().default(""),
  RESEND_API_KEY: z.string().default(""),
  EMAIL_FROM: z.string().default("Lojinha <nao-responda@example.org>"),
  R2_ACCOUNT_ID: z.string().default(""),
  R2_ACCESS_KEY_ID: z.string().default(""),
  R2_SECRET_ACCESS_KEY: z.string().default(""),
  R2_BUCKET: z.string().default(""),
  R2_PUBLIC_BASE_URL: z.string().default(""),
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
  // Price recorrente da assinatura SaaS, na conta da PLATAFORMA (não é Connect).
  STRIPE_SAAS_PRICE_ID: z.string().default(""),
  // País da conta conectada criada no onboarding — Connect exige no create.
  STRIPE_CONNECT_COUNTRY: z.string().length(2).default("BR"),
  WOOVI_API_KEY: z.string().default(""),
  WOOVI_WEBHOOK_HMAC_SECRET: z.string().default(""),
});

export const EnvSchema = BaseEnvSchema.superRefine((val, ctx) => {
  if (val.NODE_ENV !== "production") return;

  const requiredNonEmpty = [
    "RESEND_API_KEY",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
    "R2_PUBLIC_BASE_URL",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_SAAS_PRICE_ID",
    "WOOVI_API_KEY",
    "WOOVI_WEBHOOK_HMAC_SECRET",
  ] as const;
  for (const key of requiredNonEmpty) {
    if (val[key].length === 0) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is required in production`,
      });
    }
  }

  if (val.COOKIE_SECRET.length < 32) {
    ctx.addIssue({
      code: "custom",
      path: ["COOKIE_SECRET"],
      message: "COOKIE_SECRET must be at least 32 chars in production",
    });
  }
  if (val.COOKIE_SECRET === COOKIE_SECRET_PLACEHOLDER) {
    ctx.addIssue({
      code: "custom",
      path: ["COOKIE_SECRET"],
      message: "COOKIE_SECRET must not be the .env.example placeholder value",
    });
  }
});

export const env = EnvSchema.parse(process.env);
export type Env = typeof env;
