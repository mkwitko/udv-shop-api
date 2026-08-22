import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

const HOUR = 60 * 60 * 1000;

async function memberToken(
  app: FastifyInstance,
  email: string,
  storeId: string,
  role: "owner" | "staff" = "owner",
) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Pessoa", email, password: "senha-forte-123" },
  });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  await db.userStoreRole.create({ data: { userId: user.id, storeId, role } });
  const cookie = res.cookies.find((c) => c.name === "udv_rt")?.value ?? "";
  const refreshed = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    cookies: { udv_rt: cookie },
  });
  return { token: refreshed.json().accessToken as string, user };
}

function seedStore() {
  return db.store.create({
    data: { slug: "nx", name: "Núcleo X", status: "active", wooviPixKey: "nx@example.org" },
  });
}

function seedEvent(
  storeId: string,
  input: { slug: string; at: Date; endsAt?: Date; stock?: number },
) {
  return db.product.create({
    data: {
      storeId,
      slug: input.slug,
      name: `Ingresso ${input.slug}`,
      priceCents: 3000,
      stock: input.stock ?? 10,
      eventAt: input.at,
      eventEndsAt: input.endsAt ?? null,
      eventLocation: "Salão do núcleo",
    },
  });
}

describe("eventos (produto com data)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("agenda traz só evento futuro, em ordem de data, e ignora produto comum", async () => {
    const store = await seedStore();
    await seedEvent(store.id, { slug: "festa", at: new Date(Date.now() + 48 * HOUR) });
    await seedEvent(store.id, { slug: "sessao", at: new Date(Date.now() + 2 * HOUR) });
    await seedEvent(store.id, { slug: "passado", at: new Date(Date.now() - 48 * HOUR) });
    // acontecendo agora: começou há uma hora e termina em duas — continua na agenda
    await seedEvent(store.id, {
      slug: "agora",
      at: new Date(Date.now() - HOUR),
      endsAt: new Date(Date.now() + 2 * HOUR),
    });
    await db.product.create({
      data: { storeId: store.id, slug: "mel", name: "Mel", priceCents: 2500, stock: 5 },
    });

    const res = await app.inject({ method: "GET", url: "/stores/nx/events" });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((item: { slug: string }) => item.slug)).toEqual([
      "agora",
      "sessao",
      "festa",
    ]);
    expect(res.json().items[0].event).toMatchObject({ location: "Salão do núcleo" });
  });

  it("vitrine de produtos esconde ingresso; kind=todos mostra os dois", async () => {
    const store = await seedStore();
    await seedEvent(store.id, { slug: "festa", at: new Date(Date.now() + HOUR) });
    await db.product.create({
      data: { storeId: store.id, slug: "mel", name: "Mel", priceCents: 2500, stock: 5 },
    });

    const vitrine = await app.inject({ method: "GET", url: "/stores/nx/products" });
    expect(vitrine.json().items.map((i: { slug: string }) => i.slug)).toEqual(["mel"]);

    const todos = await app.inject({ method: "GET", url: "/stores/nx/products?kind=todos" });
    expect(
      todos
        .json()
        .items.map((i: { slug: string }) => i.slug)
        .sort(),
    ).toEqual(["festa", "mel"]);
  });

  it("evento que já terminou recusa checkout e não consome estoque", async () => {
    const store = await seedStore();
    const event = await seedEvent(store.id, {
      slug: "ontem",
      at: new Date(Date.now() - 48 * HOUR),
    });
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        storeSlug: "nx",
        provider: "woovi",
        items: [{ productSlug: "ontem", qty: 1 }],
        contact: { name: "Maria", phone: "11988887777" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("event_finished");
    expect((await db.product.findUniqueOrThrow({ where: { id: event.id } })).stock).toBe(10);
  });

  it("lista de presença nasce dos pedidos e o check-in liga e desliga", async () => {
    const store = await seedStore();
    const event = await seedEvent(store.id, { slug: "festa", at: new Date(Date.now() + HOUR) });
    const { token } = await memberToken(app, "dona@example.org", store.id);

    const checkout = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        storeSlug: "nx",
        provider: "woovi",
        items: [{ productSlug: "festa", qty: 2 }],
        contact: { name: "João da Fila", phone: "11977776666" },
      },
    });
    expect(checkout.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: "/stores/nx/events/festa/attendees",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      event: { slug: "festa", name: "Ingresso festa" },
      soldQty: 2,
      checkedInQty: 0,
      // duas vagas saíram do estoque na reserva do checkout
      remaining: 8,
    });
    const attendee = list.json().items[0];
    expect(attendee).toMatchObject({ name: "João da Fila", qty: 2, checkedInAt: null });
    expect(attendee.phone).toContain("11977776666");

    const inUrl = `/stores/nx/events/festa/attendees/${attendee.orderItemId}`;
    const marked = await app.inject({
      method: "PATCH",
      url: inUrl,
      headers: { authorization: `Bearer ${token}` },
      payload: { present: true },
    });
    expect(marked.statusCode).toBe(200);
    expect(marked.json().checkedInAt).not.toBeNull();

    // tocar de novo na porta não pode virar erro
    const again = await app.inject({
      method: "PATCH",
      url: inUrl,
      headers: { authorization: `Bearer ${token}` },
      payload: { present: true },
    });
    expect(again.statusCode).toBe(200);

    const afterCheckIn = await app.inject({
      method: "GET",
      url: "/stores/nx/events/festa/attendees",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(afterCheckIn.json().checkedInQty).toBe(2);

    const undone = await app.inject({
      method: "PATCH",
      url: inUrl,
      headers: { authorization: `Bearer ${token}` },
      payload: { present: false },
    });
    expect(undone.json().checkedInAt).toBeNull();
    expect(event.slug).toBe("festa");
  });

  it("item de outra loja não é marcado por quem tem papel nesta", async () => {
    const store = await seedStore();
    const other = await db.store.create({
      data: { slug: "outra", name: "Outra", status: "active", wooviPixKey: "o@example.org" },
    });
    await seedEvent(store.id, { slug: "festa", at: new Date(Date.now() + HOUR) });
    await seedEvent(other.id, { slug: "festa", at: new Date(Date.now() + HOUR) });
    const { token } = await memberToken(app, "dona2@example.org", store.id);

    const alheio = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        storeSlug: "outra",
        provider: "woovi",
        items: [{ productSlug: "festa", qty: 1 }],
        contact: { name: "Alguém", phone: "11966665555" },
      },
    });
    const orderId = alheio.json().order.id;
    const item = await db.orderItem.findFirstOrThrow({ where: { orderId } });

    const res = await app.inject({
      method: "PATCH",
      url: `/stores/nx/events/festa/attendees/${item.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { present: true },
    });
    expect(res.statusCode).toBe(404);
  });
});
