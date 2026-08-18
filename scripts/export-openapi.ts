// Gera docs/openapi.json a partir das rotas Zod já registradas — é o contrato que o
// front consome (openapi-typescript/orval) em vez de redigitar tipos à mão.
// Roda sem banco e sem credencial real: os gateways são preguiçosos e nada é conectado.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "dotenv";

// .env primeiro (dev), .env.test preenche o que faltar — dotenv não sobrescreve o que já existe.
config({ path: ".env" });
config({ path: ".env.test" });

const { buildApp } = await import("../src/app.js");

const app = await buildApp({ rateLimit: false });
await app.ready();

const spec = app.swagger();
const out = resolve("docs/openapi.json");
await writeFile(out, `${JSON.stringify(spec, null, 2)}\n`);
await app.close();

const paths = Object.keys((spec as { paths?: Record<string, unknown> }).paths ?? {}).length;
console.log(`openapi: ${paths} paths -> ${out}`);
