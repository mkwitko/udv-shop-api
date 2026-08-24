import type { Store } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { db } from "../../../infra/db/client.js";
import { NotFoundError, ValidationError } from "../../../shared/errors.js";
import { requireStoreRole, requireWritableStore } from "../../hooks/store-role.js";
import { createStoresRepository } from "../stores/stores.repository.js";
import { createEventsRepository, type EventWithSupplier } from "./events.repository.js";

/**
 * Loja da rota, com o papel exigido para mexer na agenda. Mesmo nível de produto: staff
 * cadastra e edita, porque quem organiza a sessão é quem vai estar na porta dela.
 */
export async function resolveStoreForEvents(req: FastifyRequest, slug: string): Promise<Store> {
  const store = await createStoresRepository(db).findBySlug(slug);
  if (!store) throw new NotFoundError("store_not_found");
  requireStoreRole(req, store.id, "staff");
  requireWritableStore(req, store);
  return store;
}

/** Evento da loja, ou 404. */
export async function resolveEvent(storeId: string, eventSlug: string): Promise<EventWithSupplier> {
  const event = await createEventsRepository(db).findBySlug(storeId, eventSlug);
  if (!event) throw new NotFoundError("event_not_found");
  return event;
}

/**
 * O fim tem de vir depois do começo. A checagem roda com o intervalo que vai FICAR valendo,
 * não com o que o formulário mandou: mudar só a data de início de um evento que já tem hora
 * de fim poderia deixar o intervalo invertido — e aí "já terminou" passa a valer para sempre,
 * tirando o evento da agenda sem ninguém entender por quê.
 */
export function assertEventWindow(effective: { at: Date; endsAt: Date | null }): void {
  if (effective.endsAt && effective.endsAt.getTime() <= effective.at.getTime()) {
    throw new ValidationError("event_ends_before_start");
  }
}

/**
 * Janela de cada lote tem de fechar depois de abrir. Não exigimos que os lotes fiquem em
 * ordem de preço nem de data: "promocional para quem vem de longe" no meio da fila é decisão
 * da comunidade, não erro — o que a plataforma garante é que cada lote sozinho faça sentido.
 */
export function assertBatchWindows(
  batches: Array<{
    name: string;
    opensAt?: string | null | undefined;
    closesAt?: string | null | undefined;
  }>,
): void {
  for (const batch of batches) {
    if (!batch.opensAt || !batch.closesAt) continue;
    if (new Date(batch.closesAt).getTime() <= new Date(batch.opensAt).getTime()) {
      throw new ValidationError("event_batch_window_invalid");
    }
  }
}
