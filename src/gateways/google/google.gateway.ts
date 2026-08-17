import { createRemoteJWKSet, jwtVerify } from "jose";
import { badGateway, UnauthorizedError } from "../../shared/errors.js";

export type GoogleProfile = { sub: string; email: string; emailVerified: boolean; name: string };

export type GoogleGateway = {
  authUrl(state: string, nonce: string): string;
  exchangeCode(code: string, nonce: string): Promise<GoogleProfile>;
};

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export function createGoogleGateway(cfg: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): GoogleGateway {
  return {
    authUrl(state, nonce) {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", cfg.clientId);
      url.searchParams.set("redirect_uri", cfg.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid email profile");
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);
      return url.toString();
    },
    async exchangeCode(code, nonce) {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          redirect_uri: cfg.redirectUri,
          grant_type: "authorization_code",
        }),
      });
      if (!res.ok) throw badGateway("google_token_exchange_failed", await res.text());
      const body = (await res.json()) as { id_token?: string };
      if (!body.id_token) throw badGateway("google_missing_id_token", body);
      const { payload } = await jwtVerify(body.id_token, GOOGLE_JWKS, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: cfg.clientId,
      });
      if (payload.nonce !== nonce) throw new UnauthorizedError("oauth_nonce_mismatch");
      return {
        sub: String(payload.sub),
        email: String(payload.email ?? ""),
        emailVerified: payload.email_verified === true,
        name: String(payload.name ?? payload.email ?? "Sem nome"),
      };
    },
  };
}
