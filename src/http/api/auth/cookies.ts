import type { FastifyReply } from "fastify";
import { env } from "../../../config/env.js";

export const REFRESH_COOKIE = "udv_rt";

// SameSite=None só vale com Secure — navegador descarta o cookie sem isso. Por isso
// cross-site força secure mesmo fora de produção (exige HTTPS no ambiente).
export const refreshCookieSameSite = env.COOKIE_CROSS_SITE ? ("none" as const) : ("lax" as const);
export const refreshCookieSecure = env.NODE_ENV === "production" || env.COOKIE_CROSS_SITE;

export function setRefreshCookie(reply: FastifyReply, raw: string): void {
  void reply.setCookie(REFRESH_COOKIE, raw, {
    path: "/auth",
    httpOnly: true,
    secure: refreshCookieSecure,
    sameSite: refreshCookieSameSite,
    maxAge: env.REFRESH_TOKEN_TTL_D * 24 * 60 * 60,
  });
}

export function clearRefreshCookie(reply: FastifyReply): void {
  void reply.clearCookie(REFRESH_COOKIE, { path: "/auth" });
}
