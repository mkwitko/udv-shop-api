import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { WooviBalanceResponse } from "../connect.schema.js";

const Params = z.object({ slug: z.string() });

/**
 * Saldo Pix que o núcleo ainda não recebeu. Consulta a Woovi na hora — é dinheiro, e um
 * número velho aqui faria a loja achar que já recebeu o que não recebeu.
 */
export const getWooviBalanceRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/stores/:slug/connect/woovi/balance",
    {
      config: {
        permissions: { any: ["store_owner", "store_admin"] },
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
      schema: {
        operationId: "getWooviBalance",
        tags: ["connect"],
        params: Params,
        response: { 200: WooviBalanceResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "admin");
      if (!store.wooviPixKey) {
        return { available: false, balanceCents: 0, withdrawBlocked: false };
      }
      const sub = await app.gateways.woovi.getSubAccount(store.wooviPixKey);
      if (!sub) return { available: false, balanceCents: 0, withdrawBlocked: false };
      return {
        available: true,
        balanceCents: Math.max(0, sub.balanceCents),
        withdrawBlocked: sub.withdrawBlocked,
      };
    },
  );
};
