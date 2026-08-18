import swagger, { type SwaggerTransform } from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { jsonSchemaTransform } from "fastify-type-provider-zod";

// wraps jsonSchemaTransform to inject `security: [{ bearerAuth: [] }]` into every operation
// whose route config does not opt out via `public: true` — otherwise the generated spec
// never documents which endpoints require a bearer token.
// `getStoresBySlugProducts` a partir de GET /stores/:slug/products. Sem operationId o
// codegen do front (Kubb) não tem como nomear hook nem arquivo — e gera zero arquivos.
function operationIdFor(method: string, url: string): string {
  const parts = url
    .split("/")
    .filter(Boolean)
    .map((seg) => (seg.startsWith(":") ? `by-${seg.slice(1)}` : seg));
  return [method.toLowerCase(), ...parts]
    .join("-")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+(\w)/g, (_, c: string) => c.toUpperCase());
}

const transformWithSecurity: SwaggerTransform = (input) => {
  const result = jsonSchemaTransform(input);
  const schema = result.schema as
    | { hide?: boolean; security?: unknown[]; operationId?: string }
    | undefined;
  if (schema && !schema.hide) {
    if (input.route.config?.public !== true) schema.security = [{ bearerAuth: [] }];
    const method = Array.isArray(input.route.method) ? input.route.method[0] : input.route.method;
    schema.operationId ??= operationIdFor(method ?? "get", input.url);
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
