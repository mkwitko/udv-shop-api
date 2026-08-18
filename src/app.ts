import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { env } from "./config/env.js";
import { httpRoutes } from "./http/index.js";
import { errorHandlerPlugin } from "./http/plugins/error-handler.js";
import { gatewaysPlugin } from "./http/plugins/gateways-plugin.js";
import { rateLimitPlugin } from "./http/plugins/rate-limit.js";
import { swaggerPlugin } from "./http/plugins/swagger.js";
import { logger } from "./infra/observability/logger.js";
import type { Gateways } from "./types/fastify.js";

export type BuildAppOptions = { gateways?: Gateways; rateLimit?: boolean };

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    trustProxy: env.TRUST_PROXY_HOPS,
    bodyLimit: 1_048_576,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(sensible);
  await app.register(helmet);
  await app.register(cors, {
    origin: env.NODE_ENV === "production" ? env.WEB_ORIGIN : true,
    credentials: true,
    // PUT está aqui porque existem rotas PUT (raffle config, woovi connect): sem ele o
    // preflight do navegador reprova a chamada antes de ela sair.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 86400,
  });
  await app.register(errorHandlerPlugin);
  if (opts.rateLimit ?? env.NODE_ENV !== "test") await app.register(rateLimitPlugin);
  await app.register(gatewaysPlugin, { gateways: opts.gateways });
  await app.register(swaggerPlugin);
  await app.register(cookie, { secret: env.COOKIE_SECRET });
  await app.register(httpRoutes);

  return app;
}
