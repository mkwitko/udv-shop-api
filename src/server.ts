import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { db } from "./infra/db/client.js";
import { startWorkers } from "./workers/index.js";

const app = await buildApp();
await app.listen({ port: env.PORT, host: "0.0.0.0" });

const workers = startWorkers({ db, gateways: app.gateways, log: app.log });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    workers.stop();
    await app.close();
    process.exit(0);
  });
}
