import { z } from "zod";

const EnvSchema = z.object({
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
});

export const env = EnvSchema.parse(process.env);
export type Env = typeof env;
