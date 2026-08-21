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
    /**
     * Rota pública que ainda aproveita a sessão quando ela existe. Usada pelos fluxos sem
     * conta: o mesmo endpoint atende o visitante (que manda `contact`) e quem está logado
     * (que já tem identidade). Só faz sentido junto de `public: true`.
     */
    optionalAuth?: boolean;
    permissions?: { any?: string[]; all?: string[] };
  }
}
