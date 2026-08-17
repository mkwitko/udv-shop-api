import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { Gateways } from "../types/fastify.js";
import { expireReservations } from "./expire-reservations.js";
import { relayOutbox } from "./outbox-relay.js";
import { processWebhookEvents } from "./webhook-processor.js";

export function startWorkers(deps: {
  db: PrismaClient;
  gateways: Gateways;
  log: FastifyBaseLogger;
}): { stop(): void } {
  const safe = (name: string, fn: () => Promise<unknown>) => () => {
    fn().catch((err) => deps.log.error({ err }, `worker ${name} falhou`));
  };
  const timers = [
    setInterval(
      safe("outbox", () => relayOutbox({ db: deps.db, email: deps.gateways.email, log: deps.log })),
      10_000,
    ),
    setInterval(
      safe("webhooks", () => processWebhookEvents({ db: deps.db, log: deps.log })),
      15_000,
    ),
    setInterval(
      safe("reservas", () => expireReservations({ db: deps.db })),
      60_000,
    ),
  ];
  for (const t of timers) t.unref();
  return {
    stop() {
      for (const t of timers) clearInterval(t);
    },
  };
}
