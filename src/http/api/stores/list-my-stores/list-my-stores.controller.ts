import type { FastifyPluginAsync } from "fastify";
import { db } from "../../../../infra/db/client.js";
import { requireUser } from "../../../hooks/auth.js";
import { createStoresRepository, toStoreResponse } from "../stores.repository.js";
import { MyStoresResponse } from "../stores.schema.js";

// GET /stores é público e só devolve lojas active; loja recém-criada nasce pending. Sem
// esta rota o dono cria a loja e não consegue mais encontrá-la.
export const listMyStoresRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/me/stores",
    {
      config: { permissions: { any: ["customer"] } },
      schema: {
        operationId: "listMyStores",
        tags: ["stores"],
        response: { 200: MyStoresResponse },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const rows = await createStoresRepository(db).listByMember(user.sub);
      return { items: rows.map(({ store, role }) => ({ ...toStoreResponse(store), role })) };
    },
  );
};
