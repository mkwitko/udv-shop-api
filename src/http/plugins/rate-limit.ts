import rateLimit from "@fastify/rate-limit";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { env } from "../../config/env.js";

/**
 * 100 req/min por IP em produção. Fora dela o teto é folgado: a suíte e2e inteira sai
 * de um IP só e batia no limite conforme os cenários cresciam — 429 no meio de um
 * teste parece bug de aplicação e não é.
 */
const _plugin: FastifyPluginAsync = async (app) => {
  await app.register(rateLimit, {
    max: env.NODE_ENV === "production" ? 100 : 1000,
    timeWindow: "1 minute",
  });
};

export const rateLimitPlugin = fp(_plugin, { name: "rate-limit" });

/**
 * Teto de rota sensível (login, criação de conta): rígido em produção, folgado fora
 * dela pelo mesmo motivo acima — a suíte e2e faz um login por cenário.
 */
export function strictLimit(max: number) {
  return { max: env.NODE_ENV === "production" ? max : max * 10, timeWindow: "1 minute" };
}
