import type { FastifyPluginAsync } from "fastify";
import { deleteDomainRoute } from "./delete-domain/delete-domain.controller.js";
import { getDomainRoute } from "./get-domain/get-domain.controller.js";
import { putDomainRoute } from "./put-domain/put-domain.controller.js";
import { resolveDomainRoute } from "./resolve-domain/resolve-domain.controller.js";
import { verifyDomainRoute } from "./verify-domain/verify-domain.controller.js";

export const domainsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(getDomainRoute);
  await app.register(putDomainRoute);
  await app.register(deleteDomainRoute);
  await app.register(verifyDomainRoute);
  await app.register(resolveDomainRoute);
};
