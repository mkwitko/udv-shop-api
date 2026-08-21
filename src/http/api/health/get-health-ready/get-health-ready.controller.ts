import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";

/**
 * Readiness, diferente de liveness.
 *
 * /health responde de pé com o processo vivo. Isto é liveness e serve para reiniciar um
 * processo travado — mas não distingue "a API atende" de "a API atende com o banco
 * inalcançável". Uma DATABASE_URL malformada passa pelo boot, passa pelo migrate deploy
 * (que usa MIGRATE_DATABASE_URL) e só aparece na primeira requisição real.
 *
 * O healthcheck do container e a espera do deploy usam esta rota: sem tocar o banco, o
 * rollback automático não tem como saber que o deploy quebrou.
 */
export const getHealthReadyRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/health/ready",
    {
      config: { public: true, rateLimit: false },
      schema: {
        operationId: "getHealthReady",
        tags: ["health"],
        response: {
          200: z.object({ status: z.literal("ok"), database: z.literal("up") }),
          503: z.object({ status: z.literal("degraded"), database: z.literal("down") }),
        },
      },
    },
    async (_request, reply) => {
      try {
        await db.$queryRaw`SELECT 1`;
      } catch (err) {
        // Loga o motivo: quem investiga um deploy revertido precisa saber qual era o erro,
        // e o corpo da resposta é público demais para carregá-lo.
        app.log.error({ err }, "readiness: banco inacessível");
        return reply.status(503).send({ status: "degraded" as const, database: "down" as const });
      }
      return reply.status(200).send({ status: "ok" as const, database: "up" as const });
    },
  );
};
