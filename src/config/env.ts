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
  // Janela em que reapresentar um refresh token já rotacionado é tratado como corrida do
  // cliente (duas abas, reload no meio da troca) e não como roubo. Sem ela a corrida
  // revoga a família e desloga o usuário de todo lugar. Zero = detecção estrita.
  REFRESH_REUSE_GRACE_S: z.coerce.number().default(30),
  COOKIE_SECRET: z.string().min(16),
  // `true` quando o front roda num site diferente do da API (registrable domain distinto,
  // ex.: web na Vercel e API na Fly). Nesse caso o cookie de refresh precisa de
  // SameSite=None + Secure, senão o navegador não o envia no fetch do front.
  COOKIE_CROSS_SITE: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
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
  // Eventos de conta conectada chegam num endpoint SEPARADO no Dashboard ("Connect
  // applications"), com signing secret próprio. Com um segredo só, metade dos eventos
  // — account.updated, o ciclo de vida da doação mensal — falha na assinatura e nunca
  // é processada.
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().default(""),
  // Price recorrente da assinatura SaaS, na conta da PLATAFORMA (não é Connect).
  STRIPE_SAAS_PRICE_ID: z.string().default(""),
  // País da conta conectada criada no onboarding — Connect exige no create.
  STRIPE_CONNECT_COUNTRY: z.string().length(2).default("BR"),
  // Alvo do CNAME que a loja aponta quando usa domínio próprio (ex.: "lojas.colheita.app").
  // Vazio desliga a feature: a API recusa configurar domínio sem ter para onde apontar.
  CUSTOM_DOMAIN_TARGET: z.string().default(""),
  // Workers AI da Cloudflare escreve/melhora descrição de produto. Vazio desliga a
  // feature (a rota devolve 503 e a tela esconde o botão). Reaproveita a conta do R2
  // quando CF_AI_ACCOUNT_ID não é informado — é a mesma conta Cloudflare.
  CF_AI_ACCOUNT_ID: z.string().default(""),
  CF_AI_API_TOKEN: z.string().default(""),
  /**
   * Segredo do Turnstile. Vazio desliga o desafio: as rotas sem conta seguem abertas com o
   * limite por IP, que é o que já segura abuso acidental.
   */
  TURNSTILE_SECRET_KEY: z.string().default(""),
  CF_AI_MODEL: z.string().default("@cf/meta/llama-4-scout-17b-16e-instruct"),
  WOOVI_API_KEY: z.string().default(""),
  // A Woovi tem dois ambientes com AppIDs SEPARADOS: produção (api.woovi.com) e teste
  // (api.woovi-sandbox.com, painel app.woovi-sandbox.com). AppID de um responde
  // "appID inválido" no outro, então a URL precisa acompanhar de onde veio a chave.
  WOOVI_BASE_URL: z.string().url().default("https://api.woovi.com"),
  // A Woovi aceita um evento por webhook e a secret do HMAC é por webhook. Como
  // consumimos três eventos (pago, expirado, estornado), aqui vão os três segredos
  // separados por vírgula — qualquer um que assine o corpo vale.
  WOOVI_WEBHOOK_HMAC_SECRET: z.string().default(""),
  // Taxa que Woovi e Stripe cobram por transação, como texto ("0,99%", "3,99% + R$ 0,39").
  // Quem paga é a plataforma (`fees.payer: application`, ADR-024), então isto não entra em
  // cálculo nenhum: é declaração. Texto livre de propósito — número de contrato muda por
  // acordo e por volume, e um percentual chumbado no código viraria mentira silenciosa.
  // Vazio = a tela só diz que a taxa existe e é paga pela plataforma, sem número.
  PROVIDER_FEE_PIX_TEXT: z.string().default(""),
  PROVIDER_FEE_CARD_TEXT: z.string().default(""),
  // Liga o gateway Pix falso com autoconfirmação em ~8s — só para demo/desenvolvimento
  // local sem credenciais reais. Recusado em produção (ver superRefine abaixo).
  DEV_FAKE_PAYMENTS: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
});

export const EnvSchema = BaseEnvSchema.superRefine((val, ctx) => {
  if (val.NODE_ENV !== "production") return;

  if (val.DEV_FAKE_PAYMENTS) {
    ctx.addIssue({
      code: "custom",
      path: ["DEV_FAKE_PAYMENTS"],
      message: "DEV_FAKE_PAYMENTS must be disabled in production",
    });
  }

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
    "STRIPE_CONNECT_WEBHOOK_SECRET",
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
