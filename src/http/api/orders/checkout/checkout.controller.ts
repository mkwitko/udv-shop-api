import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../../../../infra/db/client.js";
import { createGuestIdentityRepo, resolveActor } from "../../../../lib/guest-identity.js";
import { ValidationError } from "../../../../shared/errors.js";
import { assertHumanIfGuest } from "../../../hooks/captcha.js";
import { strictLimit } from "../../../plugins/rate-limit.js";
import { createEventsRepository } from "../../events/events.repository.js";
import { createProductsRepository } from "../../products/products.repository.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { createOrdersRepository, toOrderResponse } from "../orders.repository.js";
import { CheckoutBody, CheckoutResponse } from "../orders.schema.js";
import { createCheckoutService } from "./checkout.service.js";

export const checkoutRoute: FastifyPluginAsync = async (app) => {
  const service = createCheckoutService({
    orders: createOrdersRepository(db),
    stores: createStoresRepository(db),
    products: createProductsRepository(db),
    events: createEventsRepository(db),
    stripe: app.gateways.stripe,
    woovi: app.gateways.woovi,
  });
  const guests = createGuestIdentityRepo(db);
  app.post(
    "/orders",
    {
      // Público desde o fluxo sem conta: comprar de um núcleo não pode custar um cadastro. O
      // teto por IP segura abuso sem derrubar várias pessoas no mesmo wifi.
      config: { public: true, optionalAuth: true, rateLimit: strictLimit(20) },
      schema: {
        operationId: "checkout",
        tags: ["orders"],
        body: CheckoutBody,
        response: { 201: CheckoutResponse },
      },
    },
    async (req, reply) => {
      const body = req.body as CheckoutBody;
      await assertHumanIfGuest(app.gateways.turnstile, req, body.captchaToken);
      const actor = await resolveActor(guests, {
        sessionUserId: req.user?.sub,
        contact: body.contact,
      });
      // A loja liga para combinar a entrega: um pedido sem telefone não serve para nada.
      const contactPhone = body.contactPhone ?? body.contact?.phone;
      if (!contactPhone) throw new ValidationError("contact_phone_required");
      const publicToken = actor.guest ? randomUUID() : null;
      const result = await service({
        ...body,
        contactPhone,
        userId: actor.userId,
        publicToken,
      });
      void reply.code(201).send({
        order: toOrderResponse(result.order),
        payment: result.payment,
        receiptToken: publicToken,
      });
    },
  );
};
