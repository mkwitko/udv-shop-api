import type { FastifyPluginAsync } from "fastify";
import { db } from "../../../../infra/db/client.js";
import { createGuestIdentityRepo, resolveActor } from "../../../../lib/guest-identity.js";
import { NotFoundError, ValidationError } from "../../../../shared/errors.js";
import { assertHumanIfGuest } from "../../../hooks/captcha.js";
import { strictLimit } from "../../../plugins/rate-limit.js";
import { createProductsRepository } from "../../products/products.repository.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { createInterestsRepository, toInterestResponse } from "../interests.repository.js";
import { CreateInterestBody, InterestResponse } from "../interests.schema.js";

export const createInterestRoute: FastifyPluginAsync = async (app) => {
  const interests = createInterestsRepository(db);
  const stores = createStoresRepository(db);
  const products = createProductsRepository(db);
  const guests = createGuestIdentityRepo(db);
  app.post(
    "/interests",
    {
      // Público de propósito: dizer "me avise quando chegar" não vale uma senha. O rate limit
      // por IP segura criação de conta leve em massa sem derrubar um grupo que compartilha a
      // mesma rede — wifi do núcleo e NAT de operadora chegam aqui como um IP só.
      config: { public: true, optionalAuth: true, rateLimit: strictLimit(20) },
      schema: {
        operationId: "createInterest",
        tags: ["interests"],
        body: CreateInterestBody,
        response: { 201: InterestResponse },
      },
    },
    async (req, reply) => {
      const { storeSlug, productSlug, qty, note, contact, captchaToken } =
        req.body as CreateInterestBody;
      await assertHumanIfGuest(app.gateways.turnstile, req, captchaToken);
      const store = await stores.findBySlug(storeSlug);
      if (store?.status !== "active") throw new NotFoundError("store_not_found");
      const product = await products.findBySlug(store.id, productSlug);
      if (!product?.active) throw new NotFoundError("product_not_found");
      // Sob encomenda sempre aceita; produto de estoque só quando esgotou — é o
      // "me avise quando chegar" da página do produto, não uma fila paralela à venda.
      if (product.availability !== "on_demand" && product.stock > 0) {
        throw new ValidationError("product_available");
      }
      const actor = await resolveActor(guests, { sessionUserId: req.user?.sub, contact });
      const interest = await interests.upsertOpen({
        productId: product.id,
        userId: actor.userId,
        qty,
        note: note ?? null,
      });
      const response = toInterestResponse(interest);
      // O upsert é por (produto, pessoa): se o contato digitado casou com quem já tinha um
      // interesse aberto, a resposta não pode devolver a anotação daquela pessoa.
      void reply.code(201).send(actor.guest ? { ...response, note: null } : response);
    },
  );
};
