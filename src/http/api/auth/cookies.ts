import type { FastifyReply } from "fastify";
import { env } from "../../../config/env.js";

export const REFRESH_COOKIE = "udv_rt";

export function setRefreshCookie(reply: FastifyReply, raw: string): void {
  void reply.setCookie(REFRESH_COOKIE, raw, {
    path: "/auth",
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: env.REFRESH_TOKEN_TTL_D * 24 * 60 * 60,
  });
}

export function clearRefreshCookie(reply: FastifyReply): void {
  void reply.clearCookie(REFRESH_COOKIE, { path: "/auth" });
}
