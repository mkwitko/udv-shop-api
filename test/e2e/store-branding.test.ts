import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

/** Logo e capa da loja: o campo `branding` existia no banco e ninguém escrevia nele. */
describe("identidade visual da loja", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  async function ownerOf(slug: string) {
    const store = await db.store.create({ data: { slug, name: "Núcleo", status: "active" } });
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Dona", email: `dona-${slug}@example.org`, password: "senha-forte-123" },
    });
    const user = await db.user.findUniqueOrThrow({ where: { email: `dona-${slug}@example.org` } });
    await db.userStoreRole.create({ data: { userId: user.id, storeId: store.id, role: "owner" } });
    const refreshed = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { udv_rt: res.cookies.find((c) => c.name === "udv_rt")?.value ?? "" },
    });
    return { store, token: refreshed.json().accessToken as string };
  }

  it("salva logo e capa e devolve as URLs públicas", async () => {
    const { token } = await ownerOf("nucleo-a");

    const saved = await app.inject({
      method: "PATCH",
      url: "/stores/nucleo-a",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        branding: { logoKey: "stores/nucleo-a/logo.png", coverKey: "stores/nucleo-a/capa.jpg" },
      },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json().branding).toMatchObject({
      logoKey: "stores/nucleo-a/logo.png",
      coverKey: "stores/nucleo-a/capa.jpg",
    });
    expect(saved.json().branding.logoUrl).toContain("stores/nucleo-a/logo.png");

    const publicView = await app.inject({ method: "GET", url: "/stores/nucleo-a" });
    expect(publicView.json().branding.coverUrl).toContain("stores/nucleo-a/capa.jpg");
  });

  it("loja sem branding devolve null, e a vitrine cai no bloco de sempre", async () => {
    await ownerOf("nucleo-b");
    const res = await app.inject({ method: "GET", url: "/stores/nucleo-b" });
    expect(res.json().branding).toBeNull();
  });

  it("chave fora da pasta da plataforma é recusada", async () => {
    const { token } = await ownerOf("nucleo-c");
    const res = await app.inject({
      method: "PATCH",
      url: "/stores/nucleo-c",
      headers: { authorization: `Bearer ${token}` },
      payload: { branding: { logoKey: "https://site-alheio.example/logo.png" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("tirar a capa é mandar null, não string vazia", async () => {
    const { token } = await ownerOf("nucleo-d");
    await app.inject({
      method: "PATCH",
      url: "/stores/nucleo-d",
      headers: { authorization: `Bearer ${token}` },
      payload: { branding: { coverKey: "stores/nucleo-d/capa.jpg" } },
    });
    const cleared = await app.inject({
      method: "PATCH",
      url: "/stores/nucleo-d",
      headers: { authorization: `Bearer ${token}` },
      payload: { branding: { coverKey: null } },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().branding.coverKey).toBeNull();
    expect(cleared.json().branding.coverUrl).toBeNull();
  });

  it("quem não é da loja não muda a identidade dela", async () => {
    await ownerOf("nucleo-e");
    const { token } = await ownerOf("nucleo-f");
    const res = await app.inject({
      method: "PATCH",
      url: "/stores/nucleo-e",
      headers: { authorization: `Bearer ${token}` },
      payload: { branding: { logoKey: "stores/nucleo-f/logo.png" } },
    });
    expect(res.statusCode).toBe(403);
  });
});
