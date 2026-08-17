import { describe, expect, it } from "vitest";
import { EnvSchema } from "../../src/config/env.js";

const base = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  WEB_ORIGIN: "https://shop.example.org",
  JWT_PRIVATE_KEY_B64: "priv",
  JWT_PUBLIC_KEY_B64: "pub",
  COOKIE_SECRET: "a".repeat(32),
  RESEND_API_KEY: "re_live_key",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_REDIRECT_URI: "https://shop.example.org/auth/google/callback",
  R2_ACCOUNT_ID: "acc",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "bucket",
  R2_PUBLIC_BASE_URL: "https://cdn.example.org",
  STRIPE_SECRET_KEY: "sk_live_key",
  STRIPE_WEBHOOK_SECRET: "whsec_key",
  WOOVI_API_KEY: "woovi_key",
  WOOVI_WEBHOOK_HMAC_SECRET: "woovi_hmac_secret",
};

describe("env schema — production strictness", () => {
  it("accepts a fully populated production env", () => {
    expect(() => EnvSchema.parse(base)).not.toThrow();
  });

  it("rejects empty RESEND_API_KEY in production", () => {
    expect(() => EnvSchema.parse({ ...base, RESEND_API_KEY: "" })).toThrow();
  });

  it("rejects empty GOOGLE_CLIENT_ID in production", () => {
    expect(() => EnvSchema.parse({ ...base, GOOGLE_CLIENT_ID: "" })).toThrow();
  });

  it("rejects empty GOOGLE_CLIENT_SECRET in production", () => {
    expect(() => EnvSchema.parse({ ...base, GOOGLE_CLIENT_SECRET: "" })).toThrow();
  });

  it("rejects empty GOOGLE_REDIRECT_URI in production", () => {
    expect(() => EnvSchema.parse({ ...base, GOOGLE_REDIRECT_URI: "" })).toThrow();
  });

  it("rejects a COOKIE_SECRET shorter than 32 chars in production", () => {
    expect(() => EnvSchema.parse({ ...base, COOKIE_SECRET: "a".repeat(20) })).toThrow();
  });

  it("rejects the .env.example placeholder COOKIE_SECRET in production", () => {
    expect(() =>
      EnvSchema.parse({ ...base, COOKIE_SECRET: "troque-por-32-bytes-aleatorios" }),
    ).toThrow();
  });

  it("does not enforce these rules outside production", () => {
    expect(() =>
      EnvSchema.parse({
        ...base,
        NODE_ENV: "development",
        RESEND_API_KEY: "",
        GOOGLE_CLIENT_ID: "",
      }),
    ).not.toThrow();
  });
});
