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

function seedStore(slug = "nx", name = "Núcleo X") {
  return db.store.create({
    data: {
      slug,
      name,
      status: "active",
      wooviPixKey: `${slug}@example.org`,
      wooviPixKeyStatus: "verified",
    },
  });
}

function seedEvent(
  storeId: string,
  input: { slug: string; at: Date; endsAt?: Date; seats?: number },
) {
  return db.event.create({
    data: {
      storeId,
      slug: input.slug,
      name: `Evento ${input.slug}`,
      priceCents: 3000,
      seats: input.seats ?? 10,
      at: input.at,
      endsAt: input.endsAt ?? null,
      location: "Salão do núcleo",
    },
  });
}

describe("eventos", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("agenda pública traz só evento futuro, em ordem de data", async () => {
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

    const res = await app.inject({ method: "GET", url: "/stores/nx/events" });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((item: { slug: string }) => item.slug)).toEqual([
      "agora",
      "sessao",
      "festa",
    ]);
    expect(res.json().items[0]).toMatchObject({ location: "Salão do núcleo", finished: false });
  });

  it("vitrine de produtos e agenda são listas separadas", async () => {
    const store = await seedStore();
    await seedEvent(store.id, { slug: "festa", at: new Date(Date.now() + HOUR) });
    await db.product.create({
      data: { storeId: store.id, slug: "mel", name: "Mel", priceCents: 2500, stock: 5 },
    });

    // A vitrine não precisa mais filtrar evento fora: evento não mora lá.
    const vitrine = await app.inject({ method: "GET", url: "/stores/nx/products" });
    expect(vitrine.json().items.map((i: { slug: string }) => i.slug)).toEqual(["mel"]);

    const agenda = await app.inject({ method: "GET", url: "/stores/nx/events" });
    expect(agenda.json().items.map((i: { slug: string }) => i.slug)).toEqual(["festa"]);
  });

  it("produto e evento podem ter o mesmo endereço: são espaços separados", async () => {
    const store = await seedStore();
    await seedEvent(store.id, { slug: "cha", at: new Date(Date.now() + HOUR) });
    await db.product.create({
      data: { storeId: store.id, slug: "cha", name: "Chá em folha", priceCents: 2500, stock: 5 },
    });

    const produto = await app.inject({ method: "GET", url: "/stores/nx/products/cha" });
    const evento = await app.inject({ method: "GET", url: "/stores/nx/events/cha" });
    expect(produto.json().name).toBe("Chá em folha");
    expect(evento.json().name).toBe("Evento cha");
  });

  it("CRUD da agenda: cria, edita, arquiva e restaura", async () => {
    const store = await seedStore();
    const { token } = await memberToken(app, "dona-crud@example.org", store.id);
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.inject({
      method: "POST",
      url: "/stores/nx/events",
      headers: auth,
      payload: {
        name: "Mutirão da horta",
        slug: "mutirao",
        priceCents: 1000,
        seats: 15,
        at: new Date(Date.now() + 72 * HOUR).toISOString(),
        location: "Horta comunitária",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ slug: "mutirao", seats: 15, finished: false });

    // endereço repetido dentro da agenda continua barrado: o link antigo abriria a sessão nova
    const repetido = await app.inject({
      method: "POST",
      url: "/stores/nx/events",
      headers: auth,
      payload: {
        name: "Outro mutirão",
        slug: "mutirao",
        priceCents: 1000,
        seats: 5,
        at: new Date(Date.now() + 96 * HOUR).toISOString(),
      },
    });
    expect(repetido.statusCode).toBe(409);
    expect(repetido.json().message).toBe("event_slug_taken");

    const edited = await app.inject({
      method: "PATCH",
      url: "/stores/nx/events/mutirao",
      headers: auth,
      payload: { seats: 20, location: "Quintal de trás" },
    });
    expect(edited.json()).toMatchObject({ seats: 20, location: "Quintal de trás" });

    const arquivado = await app.inject({
      method: "DELETE",
      url: "/stores/nx/events/mutirao",
      headers: auth,
    });
    expect(arquivado.statusCode).toBe(204);
    const semArquivado = await app.inject({ method: "GET", url: "/stores/nx/events" });
    expect(semArquivado.json().items).toEqual([]);

    const restaurado = await app.inject({
      method: "POST",
      url: "/stores/nx/events/mutirao/restore",
      headers: auth,
    });
    expect(restaurado.json().active).toBe(true);
    const comRestaurado = await app.inject({ method: "GET", url: "/stores/nx/events" });
    expect(comRestaurado.json().items).toHaveLength(1);
  });

  it("fim antes do começo é recusado, inclusive vindo de edição parcial", async () => {
    const store = await seedStore();
    const { token } = await memberToken(app, "dona-janela@example.org", store.id);
    const auth = { authorization: `Bearer ${token}` };
    const at = new Date(Date.now() + 24 * HOUR);

    const invalido = await app.inject({
      method: "POST",
      url: "/stores/nx/events",
      headers: auth,
      payload: {
        name: "Invertido",
        slug: "invertido",
        priceCents: 1000,
        seats: 5,
        at: at.toISOString(),
        endsAt: new Date(at.getTime() - HOUR).toISOString(),
      },
    });
    expect(invalido.statusCode).toBe(400);
    expect(invalido.json().message).toBe("event_ends_before_start");

    await seedEvent(store.id, {
      slug: "com-fim",
      at,
      endsAt: new Date(at.getTime() + 2 * HOUR),
    });
    // mexe só no início, e ele passa do fim que já estava gravado
    const parcial = await app.inject({
      method: "PATCH",
      url: "/stores/nx/events/com-fim",
      headers: auth,
      payload: { at: new Date(at.getTime() + 5 * HOUR).toISOString() },
    });
    expect(parcial.statusCode).toBe(400);
    expect(parcial.json().message).toBe("event_ends_before_start");
  });

  it("agenda da gestão mostra o que já passou; a pública, não", async () => {
    const store = await seedStore();
    const { token } = await memberToken(app, "dona-passado@example.org", store.id);
    await seedEvent(store.id, { slug: "ontem", at: new Date(Date.now() - 48 * HOUR) });
    await seedEvent(store.id, { slug: "amanha", at: new Date(Date.now() + 24 * HOUR) });
    // o mais distante do futuro não pode roubar o topo do que é hoje/amanhã
    await seedEvent(store.id, { slug: "mes-que-vem", at: new Date(Date.now() + 720 * HOUR) });

    const publica = await app.inject({ method: "GET", url: "/stores/nx/events" });
    expect(publica.json().items.map((i: { slug: string }) => i.slug)).toEqual([
      "amanha",
      "mes-que-vem",
    ]);

    const gestao = await app.inject({
      method: "GET",
      url: "/stores/nx/manage/events?all=true",
      headers: { authorization: `Bearer ${token}` },
    });
    // a lista de presença de ontem vive aqui, então o passado tem de aparecer — depois do
    // que ainda vai acontecer, que é o que a tela aberta na porta precisa no topo
    expect(gestao.json().items.map((i: { slug: string }) => i.slug)).toEqual([
      "amanha",
      "mes-que-vem",
      "ontem",
    ]);
    expect(gestao.json().items.find((i: { slug: string }) => i.slug === "ontem").finished).toBe(
      true,
    );
  });

  it("comprar vaga desconta seats e o pedido diz que a linha é de evento", async () => {
    const store = await seedStore();
    const event = await seedEvent(store.id, { slug: "festa", at: new Date(Date.now() + HOUR) });

    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        storeSlug: "nx",
        provider: "woovi",
        items: [{ eventSlug: "festa", qty: 2 }],
        contact: { name: "Maria", phone: "11988887777" },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().order.items[0]).toMatchObject({ kind: "evento", slug: "festa", qty: 2 });
    expect(res.json().order.items[0].event).toMatchObject({ location: "Salão do núcleo" });
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).seats).toBe(8);
  });

  it("vaga além do que resta é recusada, e o estoque de produto não se mistura", async () => {
    const store = await seedStore();
    await seedEvent(store.id, { slug: "festa", at: new Date(Date.now() + HOUR), seats: 1 });

    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        storeSlug: "nx",
        provider: "woovi",
        items: [{ eventSlug: "festa", qty: 2 }],
        contact: { name: "Maria", phone: "11988887777" },
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe("insufficient_stock");
  });

  it("evento que já terminou recusa checkout e não consome vaga", async () => {
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
        items: [{ eventSlug: "ontem", qty: 1 }],
        contact: { name: "Maria", phone: "11988887777" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("event_finished");
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).seats).toBe(10);
  });

  it("um pedido leva produto e vaga na mesma compra", async () => {
    const store = await seedStore();
    await seedEvent(store.id, { slug: "festa", at: new Date(Date.now() + HOUR) });
    await db.product.create({
      data: { storeId: store.id, slug: "mel", name: "Mel", priceCents: 2500, stock: 5 },
    });

    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        storeSlug: "nx",
        provider: "woovi",
        items: [
          { eventSlug: "festa", qty: 1 },
          { productSlug: "mel", qty: 2 },
        ],
        contact: { name: "Maria", phone: "11988887777" },
      },
    });
    expect(res.statusCode).toBe(201);
    const kinds = res
      .json()
      .order.items.map((i: { kind: string }) => i.kind)
      .sort();
    expect(kinds).toEqual(["evento", "produto"]);
    expect(res.json().order.totalCents).toBe(3000 + 2 * 2500);
  });

  it("item sem alvo, ou com os dois, é recusado na entrada", async () => {
    await seedStore();
    const nenhum = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        storeSlug: "nx",
        provider: "woovi",
        items: [{ qty: 1 }],
        contact: { name: "Maria", phone: "11988887777" },
      },
    });
    expect(nenhum.statusCode).toBe(400);

    const dois = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        storeSlug: "nx",
        provider: "woovi",
        items: [{ productSlug: "mel", eventSlug: "festa", qty: 1 }],
        contact: { name: "Maria", phone: "11988887777" },
      },
    });
    expect(dois.statusCode).toBe(400);
  });

  it("vaga vendida gera repasse de quem conduz, como produto gera do parceiro", async () => {
    const store = await seedStore();
    const { token } = await memberToken(app, "dona-repasse@example.org", store.id);
    const supplier = await db.supplier.create({
      data: { storeId: store.id, name: "Facilitadora Ana" },
    });
    // R$ 30,00 a vaga, R$ 12,00 para quem conduz
    await db.event.create({
      data: {
        storeId: store.id,
        slug: "oficina",
        name: "Oficina de barro",
        priceCents: 3000,
        seats: 5,
        at: new Date(Date.now() + 24 * HOUR),
        supplierId: supplier.id,
        payoutKind: "fixed_cents",
        payoutValue: 1200,
      },
    });

    const compra = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        storeSlug: "nx",
        provider: "woovi",
        items: [{ eventSlug: "oficina", qty: 2 }],
        contact: { name: "Maria", phone: "11988887777" },
      },
    });
    expect(compra.statusCode).toBe(201);
    // o valor é congelado no item: mudar o acordo depois não reescreve esta venda
    const item = await db.orderItem.findFirstOrThrow({ where: { order: { storeId: store.id } } });
    expect(item.supplierId).toBe(supplier.id);
    expect(item.payoutCents).toBe(2400);

    // só entra no saldo quando o dinheiro entrou: pendente ainda pode expirar
    const pendente = await app.inject({
      method: "GET",
      url: `/stores/nx/payouts/${supplier.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(pendente.json().earnedCents).toBe(0);

    const payment = await db.payment.findFirstOrThrow({ where: { order: { storeId: store.id } } });
    await app.inject({
      method: "POST",
      url: "/webhooks/woovi",
      headers: { "x-openpix-signature": "ok", "content-type": "application/json" },
      payload: JSON.stringify({
        event: "OPENPIX:CHARGE_COMPLETED",
        charge: { correlationID: payment.id },
      }),
    });

    const pago = await app.inject({
      method: "GET",
      url: `/stores/nx/payouts/${supplier.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(pago.json().earnedCents).toBe(2400);
    // a linha do extrato diz o nome da vaga, não de um produto que não existe
    expect(pago.json().sales[0]).toMatchObject({ itemName: "Oficina de barro", qty: 2 });
  });

  it("lista de presença nasce dos pedidos e o check-in liga e desliga", async () => {
    const store = await seedStore();
    await seedEvent(store.id, { slug: "festa", at: new Date(Date.now() + HOUR) });
    const { token } = await memberToken(app, "dona@example.org", store.id);

    const checkout = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        storeSlug: "nx",
        provider: "woovi",
        items: [{ eventSlug: "festa", qty: 2 }],
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
      event: { slug: "festa", name: "Evento festa" },
      soldQty: 2,
      checkedInQty: 0,
      // duas vagas saíram na reserva do checkout
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
  });

  it("item de outra loja não é marcado por quem tem papel nesta", async () => {
    const store = await seedStore();
    const other = await seedStore("outra", "Outra");
    await seedEvent(store.id, { slug: "festa", at: new Date(Date.now() + HOUR) });
    await seedEvent(other.id, { slug: "festa", at: new Date(Date.now() + HOUR) });
    const { token } = await memberToken(app, "dona2@example.org", store.id);

    const alheio = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        storeSlug: "outra",
        provider: "woovi",
        items: [{ eventSlug: "festa", qty: 1 }],
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

  describe("venda em lotes", () => {
    async function seedComLotes(storeId: string, token: string) {
      const res = await app.inject({
        method: "POST",
        url: "/stores/nx/events",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: "Festa junina",
          slug: "festa-junina",
          priceCents: 5000,
          seats: 0,
          at: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
          batches: [
            { name: "1º lote", priceCents: 3000, seats: 2 },
            { name: "2º lote", priceCents: 4000, seats: 5 },
          ],
        },
      });
      expect(res.statusCode).toBe(201);
      return res.json();
    }

    function comprar(qty: number) {
      return app.inject({
        method: "POST",
        url: "/orders",
        payload: {
          storeSlug: "nx",
          provider: "woovi",
          items: [{ eventSlug: "festa-junina", qty }],
          contact: { name: "Maria", phone: "11988887777" },
        },
      });
    }

    it("vende pelo lote ativo e mostra o preço do próximo", async () => {
      const store = await seedStore();
      const { token } = await memberToken(app, "dona-lote@example.org", store.id);
      const criado = await seedComLotes(store.id, token);

      // preço e vaga da resposta são os do lote que está vendendo, não os do evento
      expect(criado).toMatchObject({
        priceCents: 3000,
        seats: 2,
        seatsTotalLeft: 7,
        nextPriceCents: 4000,
      });
      expect(criado.batch).toMatchObject({ name: "1º lote", current: true });

      const publico = await app.inject({ method: "GET", url: "/stores/nx/events/festa-junina" });
      expect(publico.json()).toMatchObject({ priceCents: 3000, nextPriceCents: 4000 });

      const compra = await comprar(1);
      expect(compra.statusCode).toBe(201);
      // o recibo diz de qual lote a vaga saiu, e o preço é o do lote
      expect(compra.json().order.items[0]).toMatchObject({
        name: "Festa junina — 1º lote",
        priceCents: 3000,
      });
      expect(compra.json().order.totalCents).toBe(3000);
    });

    it("lote esgotado passa a bola para o próximo, sem ninguém mexer", async () => {
      const store = await seedStore();
      const { token } = await memberToken(app, "dona-esgota@example.org", store.id);
      await seedComLotes(store.id, token);

      const primeiro = await comprar(2);
      expect(primeiro.statusCode).toBe(201);
      expect(primeiro.json().order.totalCents).toBe(6000);

      const depois = await app.inject({ method: "GET", url: "/stores/nx/events/festa-junina" });
      // 1º lote acabou: quem chega agora vê o 2º, e não há mais "próximo" mais caro
      expect(depois.json()).toMatchObject({
        priceCents: 4000,
        seats: 5,
        seatsTotalLeft: 5,
        nextPriceCents: null,
      });
      expect(depois.json().batch).toMatchObject({ name: "2º lote" });

      const segundo = await comprar(1);
      expect(segundo.json().order.items[0]).toMatchObject({
        name: "Festa junina — 2º lote",
        priceCents: 4000,
      });
    });

    it("lote fora da janela não vende, mesmo com vaga sobrando", async () => {
      const store = await seedStore();
      const { token } = await memberToken(app, "dona-janela-lote@example.org", store.id);
      const criado = await app.inject({
        method: "POST",
        url: "/stores/nx/events",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: "Curso",
          slug: "curso",
          priceCents: 5000,
          seats: 0,
          at: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
          batches: [
            // 1º lote fechou ontem; o 2º só abre amanhã: ninguém compra hoje
            {
              name: "1º lote",
              priceCents: 3000,
              seats: 5,
              closesAt: new Date(Date.now() - HOUR).toISOString(),
            },
            {
              name: "2º lote",
              priceCents: 4000,
              seats: 5,
              opensAt: new Date(Date.now() + 24 * HOUR).toISOString(),
            },
          ],
        },
      });
      expect(criado.statusCode).toBe(201);
      expect(criado.json()).toMatchObject({ seats: 0, batch: null, priceCents: 4000 });

      const res = await app.inject({
        method: "POST",
        url: "/orders",
        payload: {
          storeSlug: "nx",
          provider: "woovi",
          items: [{ eventSlug: "curso", qty: 1 }],
          contact: { name: "Maria", phone: "11988887777" },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe("event_batch_unavailable");

      // entre lotes, a fila de espera aceita: é justamente quem quer ser avisado
      const fila = await app.inject({
        method: "POST",
        url: "/interests",
        payload: {
          storeSlug: "nx",
          eventSlug: "curso",
          qty: 1,
          contact: { name: "Quem espera", phone: "11955554444" },
        },
      });
      expect(fila.statusCode).toBe(201);
    });

    it("fim antes do começo no lote é recusado", async () => {
      const store = await seedStore();
      const { token } = await memberToken(app, "dona-lote-ruim@example.org", store.id);
      const at = new Date(Date.now() + 30 * 24 * HOUR);
      const res = await app.inject({
        method: "POST",
        url: "/stores/nx/events",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: "Curso",
          slug: "curso",
          priceCents: 5000,
          seats: 0,
          at: at.toISOString(),
          batches: [
            {
              name: "1º lote",
              priceCents: 3000,
              seats: 5,
              opensAt: at.toISOString(),
              closesAt: new Date(at.getTime() - HOUR).toISOString(),
            },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe("event_batch_window_invalid");
    });

    it("editar reordena e apaga lote sem venda; lote com venda é recusado", async () => {
      const store = await seedStore();
      const { token } = await memberToken(app, "dona-edita-lote@example.org", store.id);
      const auth = { authorization: `Bearer ${token}` };
      const criado = await seedComLotes(store.id, token);
      const [primeiro, segundo] = criado.batches;

      // troca a ordem: o 2º passa a vender primeiro
      const trocado = await app.inject({
        method: "PATCH",
        url: "/stores/nx/events/festa-junina",
        headers: auth,
        payload: {
          batches: [
            { id: segundo.id, name: segundo.name, priceCents: 4000, seats: 5 },
            { id: primeiro.id, name: primeiro.name, priceCents: 3000, seats: 2 },
          ],
        },
      });
      expect(trocado.statusCode).toBe(200);
      expect(trocado.json().batches.map((b: { name: string }) => b.name)).toEqual([
        "2º lote",
        "1º lote",
      ]);
      expect(trocado.json().batch).toMatchObject({ name: "2º lote" });

      // lote sem venda sai da lista sem cerimônia
      const removido = await app.inject({
        method: "PATCH",
        url: "/stores/nx/events/festa-junina",
        headers: auth,
        payload: { batches: [{ id: segundo.id, name: "Único", priceCents: 4000, seats: 5 }] },
      });
      expect(removido.statusCode).toBe(200);
      expect(removido.json().batches).toHaveLength(1);

      // com venda, apagar levaria embora de onde veio o ingresso de alguém
      await comprar(1);
      const recusado = await app.inject({
        method: "PATCH",
        url: "/stores/nx/events/festa-junina",
        headers: auth,
        payload: { batches: [] },
      });
      expect(recusado.statusCode).toBe(409);
      expect(recusado.json().message).toBe("event_batch_has_sales");
      // e a lista continua inteira: a recusa não gravou nada pela metade
      const depois = await app.inject({ method: "GET", url: "/stores/nx/events/festa-junina" });
      expect(depois.json().batches).toHaveLength(1);
    });

    it("pedido que expira devolve a vaga para o lote de onde ela saiu", async () => {
      const store = await seedStore();
      const { token } = await memberToken(app, "dona-devolve@example.org", store.id);
      await seedComLotes(store.id, token);

      const compra = await comprar(2);
      const orderId = compra.json().order.id as string;
      const esgotado = await app.inject({ method: "GET", url: "/stores/nx/events/festa-junina" });
      expect(esgotado.json().batch).toMatchObject({ name: "2º lote" });

      // expira o pendente: a vaga volta para o 1º lote, que reassume a venda
      await db.order.update({
        where: { id: orderId },
        data: { expiresAt: new Date(Date.now() - HOUR) },
      });
      const { expireReservations } = await import("../../src/workers/expire-reservations.js");
      await expireReservations({ db });

      const voltou = await app.inject({ method: "GET", url: "/stores/nx/events/festa-junina" });
      expect(voltou.json()).toMatchObject({ priceCents: 3000, seats: 2 });
    });
  });

  it("resultado do evento separa vaga garantida de dinheiro que entrou", async () => {
    const store = await seedStore();
    const { token } = await memberToken(app, "dona-resultado@example.org", store.id);
    const supplier = await db.supplier.create({
      data: { storeId: store.id, name: "Facilitadora Ana" },
    });
    const event = await db.event.create({
      data: {
        storeId: store.id,
        slug: "ontem",
        name: "Roda de ontem",
        priceCents: 3000,
        seats: 10,
        at: new Date(Date.now() + 24 * HOUR),
        supplierId: supplier.id,
        payoutKind: "fixed_cents",
        payoutValue: 1000,
      },
    });

    // duas compras: uma paga, outra que ficou no Pix pendente
    const pago = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        storeSlug: "nx",
        provider: "woovi",
        items: [{ eventSlug: "ontem", qty: 2 }],
        contact: { name: "Quem pagou", phone: "11988887777" },
      },
    });
    await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        storeSlug: "nx",
        provider: "woovi",
        items: [{ eventSlug: "ontem", qty: 1 }],
        contact: { name: "Quem não pagou", phone: "11977776666" },
      },
    });
    expect(pago.statusCode).toBe(201);
    const payment = await db.payment.findFirstOrThrow({
      where: { orderId: pago.json().order.id as string },
    });
    await app.inject({
      method: "POST",
      url: "/webhooks/woovi",
      headers: { "x-openpix-signature": "ok", "content-type": "application/json" },
      payload: JSON.stringify({
        event: "OPENPIX:CHARGE_COMPLETED",
        charge: { correlationID: payment.id },
      }),
    });

    // vender só acontece antes; o resultado se lê depois. A data anda para trás aqui.
    await db.event.update({
      where: { id: event.id },
      data: { at: new Date(Date.now() - 24 * HOUR) },
    });

    const res = await app.inject({
      method: "GET",
      url: "/stores/nx/manage/events/results",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({
      slug: "ontem",
      finished: true,
      // três vagas saíram (as duas contam para a porta), sete sobraram
      soldQty: 3,
      seatsLeft: 7,
      // dinheiro conta só o pedido pago: 2 × R$ 30,00 menos 2 × R$ 10,00 de repasse
      paidQty: 2,
      grossCents: 6000,
      payoutCents: 2000,
      // 1 centavo mesmo com comissão zero: a Woovi recusa split de 100%, então esse
      // centavo fica retido e NÃO chega na conta da loja. O líquido tem de dizer isso.
      feeCents: 1,
      netCents: 3999,
      checkedInQty: 0,
    });
  });

  it("resultado esconde o que ainda não aconteceu, e staff não vê dinheiro", async () => {
    const store = await seedStore();
    const { token } = await memberToken(app, "dona-futuro@example.org", store.id);
    const staff = await memberToken(app, "equipe@example.org", store.id, "staff");
    await seedEvent(store.id, { slug: "amanha", at: new Date(Date.now() + 24 * HOUR) });
    await seedEvent(store.id, { slug: "ontem", at: new Date(Date.now() - 24 * HOUR) });

    const padrao = await app.inject({
      method: "GET",
      url: "/stores/nx/manage/events/results",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(padrao.statusCode).toBe(200);
    // resultado de evento que nem começou é zero: não polui a lista
    expect(padrao.json().items.map((i: { slug: string }) => i.slug)).toEqual(["ontem"]);

    const comFuturo = await app.inject({
      method: "GET",
      url: "/stores/nx/manage/events/results?upcoming=true",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(comFuturo.json().items.map((i: { slug: string }) => i.slug)).toEqual([
      "amanha",
      "ontem",
    ]);

    // staff marca presença mas não vê receita, como em todo resto que fala de dinheiro
    const negado = await app.inject({
      method: "GET",
      url: "/stores/nx/manage/events/results",
      headers: { authorization: `Bearer ${staff.token}` },
    });
    expect(negado.statusCode).toBe(403);
  });

  it("fila de espera de evento lotado avisa quem esperava quando abre vaga", async () => {
    const store = await seedStore();
    const event = await seedEvent(store.id, {
      slug: "lotada",
      at: new Date(Date.now() + 24 * HOUR),
      seats: 0,
    });
    const { token } = await memberToken(app, "dona-fila@example.org", store.id);

    const naFila = await app.inject({
      method: "POST",
      url: "/interests",
      payload: {
        storeSlug: "nx",
        eventSlug: "lotada",
        qty: 1,
        contact: { name: "Quem espera", phone: "11955554444" },
      },
    });
    expect(naFila.statusCode).toBe(201);
    expect(naFila.json()).toMatchObject({ kind: "evento", product: null });
    expect(naFila.json().event).toMatchObject({ slug: "lotada" });

    // com vaga aberta, o caminho certo é comprar — não entrar na fila
    await db.event.update({ where: { id: event.id }, data: { seats: 3 } });
    const comVaga = await app.inject({
      method: "POST",
      url: "/interests",
      payload: {
        storeSlug: "nx",
        eventSlug: "lotada",
        qty: 1,
        contact: { name: "Outra pessoa", phone: "11944443333" },
      },
    });
    expect(comVaga.statusCode).toBe(400);
    expect(comVaga.json().message).toBe("event_has_seats");

    const avisados = await app.inject({
      method: "POST",
      url: "/stores/nx/events/lotada/interests/notify",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(avisados.json()).toEqual({ notified: 1 });

    const demanda = await app.inject({
      method: "GET",
      url: "/stores/nx/interests/demand",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(demanda.json().items[0]).toMatchObject({
      kind: "evento",
      product: null,
      notifiedCount: 1,
      totalQty: 1,
    });
  });
});
