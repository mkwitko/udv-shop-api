import type { Gateways } from "./fastify.js";

declare module "fastify" {
  interface FastifyInstance {
    gateways: Gateways;
  }
  interface FastifyRequest {
    user?: { sub: string; platformAdmin: boolean; roles: Record<string, string> };
  }
  interface FastifyContextConfig {
    public?: boolean;
    permissions?: { any?: string[]; all?: string[] };
  }
}
