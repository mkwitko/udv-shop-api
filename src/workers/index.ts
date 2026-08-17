import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { Gateways } from "../types/fastify.js";
import { expireDonations } from "./expire-donations.js";
import { expireReservations } from "./expire-reservations.js";
import { relayOutbox } from "./outbox-relay.js";
import { processWebhookEvents } from "./webhook-processor.js";

export function startWorkers(deps: {
  db: PrismaClient;
  gateways: Gateways;
  log: FastifyBaseLogger;
}): { stop(): void } {
  // Re-entrancy guard: skips a tick while the previous invocation of that same tick is
  // still running (a slow tick — e.g. 50 outbox events × email latency — would otherwise
  // overlap the next interval firing and double-process rows).
  const guarded = (name: string, fn: () => Promise<unknown>) => {
    let running = false;
    return () => {
      if (running) return;
      running = true;
      fn()
        .catch((err) => deps.log.error({ err }, `worker ${name} falhou`))
        .finally(() => {
          running = false;
        });
    };
  };
  const timers = [
    setInterval(
      guarded("outbox", () =>
        relayOutbox({ db: deps.db, email: deps.gateways.email, log: deps.log }),
      ),
      10_000,
    ),
    setInterval(
      guarded("webhooks", () => processWebhookEvents({ db: deps.db, log: deps.log })),
      15_000,
    ),
    setInterval(
      guarded("reservas", () => expireReservations({ db: deps.db })),
      60_000,
    ),
    setInterval(
      guarded("doacoes", () => expireDonations({ db: deps.db })),
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
