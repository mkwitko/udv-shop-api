import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways, type FakeGateways } from "../mocks/gateways.fake.js";

async function register(app: FastifyInstance, email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Pessoa", email, password: "senha-forte-123" },
  });
  return {
    token: res.json().accessToken as string,
    cookie: res.cookies.find((c) => c.name === "udv_rt")?.value ?? "",
  };
}

async function member(
  app: FastifyInstance,
  email: string,
  storeId: string,
  role: "owner" | "admin" | "staff",
) {
  const { cookie } = await register(app, email);
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  await db.userStoreRole.create({ data: { userId: user.id, storeId, role } });
  const refreshed = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    cookies: { udv_rt: cookie },
  });
  return refreshed.json().accessToken as string;
}

function tokenFromEmail(html: string): string {
  const m = html.match(/\/convite\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`sem link de convite no e-mail: ${html}`);
  return m[1] as string;
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe("equipe da loja", () => {
  let app: FastifyInstance;
  let gw: FakeGateways;
  let storeId: string;
  let owner: string;

  beforeAll(async () => {
    gw = buildFakeGateways();
    app = await buildApp({ gateways: gw });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    storeId = (await db.store.create({ data: { slug: "nx", name: "NX", status: "active" } })).id;
    owner = await member(app, "own@example.org", storeId, "owner");
    gw.sentEmails.length = 0; // o registro do owner manda e-mail de verificação
  });

  it("owner convida por e-mail; convite aparece como pendente e e-mail sai com link", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/team/invites",
      headers: auth(owner),
      payload: { email: "Ana@Example.org", role: "admin" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: "ana@example.org", role: "admin" });

    expect(gw.sentEmails).toHaveLength(1);
    expect(gw.sentEmails[0]?.to).toBe("ana@example.org");
    expect(gw.sentEmails[0]?.html).toContain("/convite/");

    const team = await app.inject({ method: "GET", url: "/stores/nx/team", headers: auth(owner) });
    expect(team.statusCode).toBe(200);
    expect(team.json().members).toHaveLength(1);
    expect(team.json().members[0]).toMatchObject({ email: "own@example.org", role: "owner" });
    expect(team.json().invites).toHaveLength(1);
    expect(team.json().invites[0]).toMatchObject({ email: "ana@example.org", role: "admin" });
  });

  it("admin não convida (403); papel owner não é convidável (400)", async () => {
    const admin = await member(app, "adm@example.org", storeId, "admin");
    const deny = await app.inject({
      method: "POST",
      url: "/stores/nx/team/invites",
      headers: auth(admin),
      payload: { email: "x@example.org", role: "staff" },
    });
    expect(deny.statusCode).toBe(403);

    const bad = await app.inject({
      method: "POST",
      url: "/stores/nx/team/invites",
      headers: auth(owner),
      payload: { email: "x@example.org", role: "owner" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("reenviar para o mesmo e-mail renova o convite pendente em vez de duplicar", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/stores/nx/team/invites",
      headers: auth(owner),
      payload: { email: "ana@example.org", role: "staff" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/stores/nx/team/invites",
      headers: auth(owner),
      payload: { email: "ana@example.org", role: "admin" },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
    expect(second.json().role).toBe("admin");
    expect(await db.storeInvite.count()).toBe(1);
    expect(gw.sentEmails).toHaveLength(2);
    // token antigo morre
    const oldToken = tokenFromEmail(gw.sentEmails[0]?.html ?? "");
    const stale = await app.inject({ method: "GET", url: `/invites/${oldToken}` });
    expect(stale.statusCode).toBe(404);
  });

  it("e-mail que já é membro → 409", async () => {
    await member(app, "adm@example.org", storeId, "admin");
    const res = await app.inject({
      method: "POST",
      url: "/stores/nx/team/invites",
      headers: auth(owner),
      payload: { email: "adm@example.org", role: "staff" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("convite público mostra loja e papel; aceite com o e-mail certo vira membro e devolve token com o papel", async () => {
    await app.inject({
      method: "POST",
      url: "/stores/nx/team/invites",
      headers: auth(owner),
      payload: { email: "ana@example.org", role: "admin" },
    });
    const token = tokenFromEmail(gw.sentEmails[0]?.html ?? "");

    const peek = await app.inject({ method: "GET", url: `/invites/${token}` });
    expect(peek.statusCode).toBe(200);
    expect(peek.json()).toMatchObject({
      storeName: "NX",
      storeSlug: "nx",
      role: "admin",
      email: "ana@example.org",
    });

    const ana = await register(app, "ana@example.org");
    const accept = await app.inject({
      method: "POST",
      url: `/invites/${token}/accept`,
      headers: auth(ana.token),
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().accessToken).toBeTypeOf("string");
    expect(accept.cookies.find((c) => c.name === "udv_rt")).toBeTruthy();

    const role = await db.userStoreRole.findUnique({
      where: { userId_storeId: { userId: accept.json().user.id, storeId } },
    });
    expect(role?.role).toBe("admin");

    // novo token já enxerga a loja
    const edit = await app.inject({
      method: "PATCH",
      url: "/stores/nx",
      headers: auth(accept.json().accessToken),
      payload: { name: "Editado pela Ana" },
    });
    expect(edit.statusCode).toBe(200);

    // convite consumido
    const again = await app.inject({ method: "GET", url: `/invites/${token}` });
    expect(again.statusCode).toBe(404);
  });

  it("aceite com outro e-mail → 403; deslogado → 401; expirado → 410", async () => {
    await app.inject({
      method: "POST",
      url: "/stores/nx/team/invites",
      headers: auth(owner),
      payload: { email: "ana@example.org", role: "staff" },
    });
    const token = tokenFromEmail(gw.sentEmails[0]?.html ?? "");

    const anon = await app.inject({ method: "POST", url: `/invites/${token}/accept` });
    expect(anon.statusCode).toBe(401);

    const bob = await register(app, "bob@example.org");
    const mismatch = await app.inject({
      method: "POST",
      url: `/invites/${token}/accept`,
      headers: auth(bob.token),
    });
    expect(mismatch.statusCode).toBe(403);

    await db.storeInvite.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await app.inject({ method: "GET", url: `/invites/${token}` });
    expect(expired.statusCode).toBe(410);
    const ana = await register(app, "ana@example.org");
    const acceptExpired = await app.inject({
      method: "POST",
      url: `/invites/${token}/accept`,
      headers: auth(ana.token),
    });
    expect(acceptExpired.statusCode).toBe(410);
  });

  it("owner revoga convite; token some", async () => {
    const inv = await app.inject({
      method: "POST",
      url: "/stores/nx/team/invites",
      headers: auth(owner),
      payload: { email: "ana@example.org", role: "staff" },
    });
    const token = tokenFromEmail(gw.sentEmails[0]?.html ?? "");
    const del = await app.inject({
      method: "DELETE",
      url: `/stores/nx/team/invites/${inv.json().id}`,
      headers: auth(owner),
    });
    expect(del.statusCode).toBe(204);
    const peek = await app.inject({ method: "GET", url: `/invites/${token}` });
    expect(peek.statusCode).toBe(404);
    const team = await app.inject({ method: "GET", url: "/stores/nx/team", headers: auth(owner) });
    expect(team.json().invites).toHaveLength(0);
  });

  it("owner muda papel e remove membro; owner é intocável", async () => {
    await member(app, "adm@example.org", storeId, "admin");
    const adm = await db.user.findUniqueOrThrow({ where: { email: "adm@example.org" } });
    const own = await db.user.findUniqueOrThrow({ where: { email: "own@example.org" } });

    const patch = await app.inject({
      method: "PATCH",
      url: `/stores/nx/team/${adm.id}`,
      headers: auth(owner),
      payload: { role: "staff" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().role).toBe("staff");

    const selfPatch = await app.inject({
      method: "PATCH",
      url: `/stores/nx/team/${own.id}`,
      headers: auth(owner),
      payload: { role: "staff" },
    });
    expect(selfPatch.statusCode).toBe(400);

    const selfDel = await app.inject({
      method: "DELETE",
      url: `/stores/nx/team/${own.id}`,
      headers: auth(owner),
    });
    expect(selfDel.statusCode).toBe(400);

    const del = await app.inject({
      method: "DELETE",
      url: `/stores/nx/team/${adm.id}`,
      headers: auth(owner),
    });
    expect(del.statusCode).toBe(204);
    expect(await db.userStoreRole.count({ where: { storeId } })).toBe(1);

    const missing = await app.inject({
      method: "DELETE",
      url: `/stores/nx/team/${adm.id}`,
      headers: auth(owner),
    });
    expect(missing.statusCode).toBe(404);
  });
});
