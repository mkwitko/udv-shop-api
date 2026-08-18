import type { FastifyPluginAsync } from "fastify";
import { createSettlementRoute } from "./create-settlement/create-settlement.controller.js";
import { createSupplierRoute } from "./create-supplier/create-supplier.controller.js";
import { getPayoutRoute } from "./get-payout/get-payout.controller.js";
import { listPayoutsRoute } from "./list-payouts/list-payouts.controller.js";
import { listSuppliersRoute } from "./list-suppliers/list-suppliers.controller.js";
import { updateSupplierRoute } from "./update-supplier/update-supplier.controller.js";

export const payoutsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(listSuppliersRoute);
  await app.register(createSupplierRoute);
  await app.register(updateSupplierRoute);
  await app.register(listPayoutsRoute);
  await app.register(getPayoutRoute);
  await app.register(createSettlementRoute);
};
