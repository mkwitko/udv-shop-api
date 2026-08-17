import type { GoogleProfile } from "../../src/gateways/google/google.gateway.js";
import type { Gateways } from "../../src/types/fastify.js";

export type FakeGateways = Gateways & {
  sentEmails: Array<{ to: string; subject: string; html: string }>;
  googleProfile: GoogleProfile;
};

export function buildFakeGateways(overrides: Partial<Gateways> = {}): FakeGateways {
  const sentEmails: FakeGateways["sentEmails"] = [];
  const googleProfile: GoogleProfile = {
    sub: "google-sub-1",
    email: "google@example.org",
    emailVerified: true,
    name: "Pessoa Google",
  };
  return {
    sentEmails,
    googleProfile,
    email: overrides.email ?? {
      async send(input) {
        sentEmails.push(input);
      },
    },
    google:
      overrides.google ??
      ({
        authUrl: (state: string, nonce: string) =>
          `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&nonce=${nonce}`,
        exchangeCode: async () => googleProfile,
      } satisfies Gateways["google"]),
  };
}
