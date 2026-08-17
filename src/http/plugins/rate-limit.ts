import rateLimit from "@fastify/rate-limit";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

const _plugin: FastifyPluginAsync = async (app) => {
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
};

export const rateLimitPlugin = fp(_plugin, { name: "rate-limit" });
