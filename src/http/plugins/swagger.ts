import swagger, { type SwaggerTransform } from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { jsonSchemaTransform } from "fastify-type-provider-zod";

// wraps jsonSchemaTransform to inject `security: [{ bearerAuth: [] }]` into every operation
// whose route config does not opt out via `public: true` — otherwise the generated spec
// never documents which endpoints require a bearer token.
const transformWithSecurity: SwaggerTransform = (input) => {
  const result = jsonSchemaTransform(input);
  if (result.schema && !result.schema.hide && input.route.config?.public !== true) {
    (result.schema as { security?: unknown[] }).security = [{ bearerAuth: [] }];
  }
  return result;
};

const _plugin: FastifyPluginAsync = async (app) => {
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: { title: "udv-shop-api", version: "0.1.0" },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
    },
    transform: transformWithSecurity,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
};

export const swaggerPlugin = fp(_plugin, { name: "swagger" });
