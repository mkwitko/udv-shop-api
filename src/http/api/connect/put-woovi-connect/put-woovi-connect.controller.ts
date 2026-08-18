import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { toConnectStatusResponse } from "../connect.helpers.js";
import { ConnectStatusResponse, PutWooviConnectBody } from "../connect.schema.js";

const Params = z.object({ slug: z.string() });

export const putWooviConnectRoute: FastifyPluginAsync = async (app) => {
  app.put(
    "/stores/:slug/connect/woovi",
    {
      config: {
        permissions: { any: ["store_owner"] },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      schema: {
        operationId: "putWooviConnect",
        tags: ["connect"],
        params: Params,
        body: PutWooviConnectBody,
        response: { 200: ConnectStatusResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "owner");
      requireWritableStore(req, store);
      const { pixKey } = req.body as PutWooviConnectBody;
      // A subconta nasce na Woovi antes de gravarmos: sem ela o `SPLIT_SUB_ACCOUNT` da
      // cobrança falha, e uma chave gravada sem subconta viraria Pix quebrado no checkout.
      const { subAccountId } = await app.gateways.woovi.createSubAccount({
        name: store.name,
        pixKey,
      });
      const updated = await createStoresRepository(db).setWooviConnect(store.id, {
        pixKey,
        subaccountId: subAccountId,
      });
      return toConnectStatusResponse(updated);
    },
  );
};
