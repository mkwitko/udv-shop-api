import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways, type FakeGateways } from "../mocks/gateways.fake.js";

const TARGET = "lojas.colheita.app";

async function tokenWithRole(
  app: FastifyInstance,
  email: string,
  storeId: string,
  role: "owner" | "admin" | "staff",
) {
  await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Pessoa", email, password: "senha-forte-123" },
  });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  await db.userStoreRole.create({ data: { userId: user.id, storeId, role } });
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password: "senha-forte-123" },
  });
  return login.json().accessToken as string;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("domínio próprio da loja", () => {
  let app: FastifyInstance;
  let gateways: FakeGateways;
  beforeAll(async () => {
    gateways = buildFakeGateways();
    app = await buildApp({ gateways });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    gateways.dnsCnames.clear();
  });

  async function seedStore(slug = "nucleo-a") {
    return db.store.create({ data: { slug, name: "Núcleo A", status: "active" } });
  }

  it("owner grava o domínio normalizado e ele começa sem verificação", async () => {
    const store = await seedStore();
    const token = await tokenWithRole(app, "dono@example.org", store.id, "owner");

    const res = await app.inject({
      method: "PUT",
      url: "/stores/nucleo-a/domain",
      headers: auth(token),
      payload: { domain: "https://Loja.Exemplo.org/" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      domain: "loja.exemplo.org",
      verified: false,
      target: TARGET,
      enabled: true,
    });
  });

  it("admin lê o status, mas só owner muda", async () => {
    const store = await seedStore();
    const admin = await tokenWithRole(app, "adm@example.org", store.id, "admin");

    const read = await app.inject({
      method: "GET",
      url: "/stores/nucleo-a/domain",
      headers: auth(admin),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().domain).toBeNull();

    const write = await app.inject({
      method: "PUT",
      url: "/stores/nucleo-a/domain",
      headers: auth(admin),
      payload: { domain: "loja.exemplo.org" },
    });
    expect(write.statusCode).toBe(403);
  });

  it("recusa endereço inválido e endereço da própria plataforma", async () => {
    const store = await seedStore();
    const token = await tokenWithRole(app, "dono2@example.org", store.id, "owner");

    for (const [domain, message] of [
      ["localhost", "invalid_domain"],
      ["nao é dominio", "invalid_domain"],
      [`minha-loja.${TARGET}`, "domain_belongs_to_platform"],
      [TARGET, "domain_belongs_to_platform"],
    ] as const) {
      const res = await app.inject({
        method: "PUT",
        url: "/stores/nucleo-a/domain",
        headers: auth(token),
        payload: { domain },
      });
      expect(res.statusCode, domain).toBe(400);
      expect(res.json().message, domain).toBe(message);
    }
  });

  it("mesmo domínio em duas lojas dá 409", async () => {
    const first = await seedStore("nucleo-a");
    const second = await seedStore("nucleo-b");
    const owner1 = await tokenWithRole(app, "d1@example.org", first.id, "owner");
    const owner2 = await tokenWithRole(app, "d2@example.org", second.id, "owner");

    const ok = await app.inject({
      method: "PUT",
      url: "/stores/nucleo-a/domain",
      headers: auth(owner1),
      payload: { domain: "loja.exemplo.org" },
    });
    expect(ok.statusCode).toBe(200);

    const clash = await app.inject({
      method: "PUT",
      url: "/stores/nucleo-b/domain",
      headers: auth(owner2),
      payload: { domain: "loja.exemplo.org" },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().message).toBe("domain_in_use");
  });

  it("verificação depende do CNAME e o domínio só resolve depois dela", async () => {
    const store = await seedStore();
    const token = await tokenWithRole(app, "dono3@example.org", store.id, "owner");
    await app.inject({
      method: "PUT",
      url: "/stores/nucleo-a/domain",
      headers: auth(token),
      payload: { domain: "loja.exemplo.org" },
    });

    // antes de verificar, o host não resolve para ninguém
    const early = await app.inject({
      method: "GET",
      url: "/stores/by-domain?host=loja.exemplo.org",
    });
    expect(early.statusCode).toBe(404);

    // CNAME apontando para outro lugar não verifica, e diz o que encontrou
    gateways.dnsCnames.set("loja.exemplo.org", ["outra-plataforma.com"]);
    const wrong = await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/domain/verify",
      headers: auth(token),
    });
    expect(wrong.json()).toMatchObject({ verified: false, found: ["outra-plataforma.com"] });

    gateways.dnsCnames.set("loja.exemplo.org", [TARGET]);
    const right = await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/domain/verify",
      headers: auth(token),
    });
    expect(right.json()).toMatchObject({ verified: true, found: [TARGET] });
    expect(right.json().verifiedAt).not.toBeNull();

    const resolved = await app.inject({
      method: "GET",
      url: "/stores/by-domain?host=HTTPS://Loja.Exemplo.org/",
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().slug).toBe("nucleo-a");
  });

  it("trocar o domínio zera a verificação", async () => {
    const store = await seedStore();
    const token = await tokenWithRole(app, "dono4@example.org", store.id, "owner");
    await app.inject({
      method: "PUT",
      url: "/stores/nucleo-a/domain",
      headers: auth(token),
      payload: { domain: "loja.exemplo.org" },
    });
    gateways.dnsCnames.set("loja.exemplo.org", [TARGET]);
    await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/domain/verify",
      headers: auth(token),
    });

    const moved = await app.inject({
      method: "PUT",
      url: "/stores/nucleo-a/domain",
      headers: auth(token),
      payload: { domain: "nova.exemplo.org" },
    });
    expect(moved.json()).toMatchObject({ domain: "nova.exemplo.org", verified: false });

    const oldHost = await app.inject({
      method: "GET",
      url: "/stores/by-domain?host=loja.exemplo.org",
    });
    expect(oldHost.statusCode).toBe(404);
  });

  it("soltar o domínio devolve a loja ao link da plataforma", async () => {
    const store = await seedStore();
    const token = await tokenWithRole(app, "dono5@example.org", store.id, "owner");
    await app.inject({
      method: "PUT",
      url: "/stores/nucleo-a/domain",
      headers: auth(token),
      payload: { domain: "loja.exemplo.org" },
    });

    const res = await app.inject({
      method: "DELETE",
      url: "/stores/nucleo-a/domain",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ domain: null, verified: false });
  });

  it("verificar sem domínio configurado é erro claro", async () => {
    const store = await seedStore();
    const token = await tokenWithRole(app, "dono6@example.org", store.id, "owner");
    const res = await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/domain/verify",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("domain_not_set");
  });

  it("loja suspensa continua resolvendo pelo domínio: a página dela avisa", async () => {
    const store = await seedStore();
    const token = await tokenWithRole(app, "dono7@example.org", store.id, "owner");
    await app.inject({
      method: "PUT",
      url: "/stores/nucleo-a/domain",
      headers: auth(token),
      payload: { domain: "loja.exemplo.org" },
    });
    gateways.dnsCnames.set("loja.exemplo.org", [TARGET]);
    await app.inject({
      method: "POST",
      url: "/stores/nucleo-a/domain/verify",
      headers: auth(token),
    });
    await db.store.update({ where: { id: store.id }, data: { status: "suspended" } });

    const res = await app.inject({
      method: "GET",
      url: "/stores/by-domain?host=loja.exemplo.org",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("suspended");
  });
});
