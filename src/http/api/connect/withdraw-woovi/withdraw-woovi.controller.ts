import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ValidationError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { WooviWithdrawResponse } from "../connect.schema.js";

const Params = z.object({ slug: z.string() });

/**
 * Saque manual do saldo Pix para a chave da loja. O saque automático roda a cada Pix
 * confirmado (outbox `woovi.withdraw`); este botão existe para o que sobra: saldo preso
 * por falha no automático, ou dinheiro que entrou antes do automático existir.
 *
 * Só owner: é movimentação de dinheiro, não configuração.
 */
export const withdrawWooviRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/stores/:slug/connect/woovi/withdraw",
    {
      config: {
        permissions: { any: ["store_owner"] },
        rateLimit: { max: 6, timeWindow: "1 minute" },
      },
      schema: {
        operationId: "withdrawWoovi",
        tags: ["connect"],
        params: Params,
        response: { 200: WooviWithdrawResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "owner");
      requireWritableStore(req, store);
      if (!store.wooviPixKey) throw new ValidationError("payments_not_configured");

      // saldo lido ANTES: o saque leva tudo, então depois dele a Woovi devolveria zero e
      // a tela não teria como dizer quanto saiu.
      const antes = await app.gateways.woovi.getSubAccount(store.wooviPixKey);
      const result = await app.gateways.woovi.withdrawSubAccount(store.wooviPixKey);
      if (result.status === "blocked") {
        req.log.error(
          { storeId: store.id, motivo: result.message },
          "saque Woovi bloqueado no pedido manual",
        );
      }
      return {
        status: result.status,
        balanceCents: result.status === "requested" ? Math.max(0, antes?.balanceCents ?? 0) : 0,
      };
    },
  );
};
