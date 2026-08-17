import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { GoogleProfile } from "../../src/gateways/google/google.gateway.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways, type FakeGateways } from "../mocks/gateways.fake.js";

/** Boots an app whose fake google gateway always resolves the given profile, and drives a
 * full start → callback round-trip against it, returning the callback response. */
async function callbackWithProfile(profile: GoogleProfile) {
  const fakes = buildFakeGateways({
    google: {
      authUrl: (state: string, nonce: string) =>
        `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&nonce=${nonce}`,
      exchangeCode: async () => profile,
    },
  });
  const app = await buildApp({ gateways: fakes });
  await app.ready();
  try {
    const start = await app.inject({ method: "GET", url: "/auth/google/start" });
    const state = start.cookies.find((c) => c.name === "udv_oauth_state");
    const nonce = start.cookies.find((c) => c.name === "udv_oauth_nonce");
    const stateValue = decodeURIComponent(state?.value ?? "").split(".")[0] ?? "";
    const res = await app.inject({
      method: "GET",
      url: `/auth/google/callback?code=fake-code&state=${stateValue}`,
      cookies: { udv_oauth_state: state?.value ?? "", udv_oauth_nonce: nonce?.value ?? "" },
    });
    return res;
  } finally {
    await app.close();
  }
}

describe("google oauth", () => {
  let app: FastifyInstance;
  let fakes: FakeGateways;
  beforeAll(async () => {
    fakes = buildFakeGateways();
    app = await buildApp({ gateways: fakes });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("start redireciona pro google com state", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/google/start" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("accounts.google.com");
    expect(res.cookies.find((c) => c.name === "udv_oauth_state")).toBeTruthy();
  });

  it("callback cria user e seta refresh cookie", async () => {
    const start = await app.inject({ method: "GET", url: "/auth/google/start" });
    const state = start.cookies.find((c) => c.name === "udv_oauth_state");
    const nonce = start.cookies.find((c) => c.name === "udv_oauth_nonce");
    const stateValue = decodeURIComponent(state?.value ?? "").split(".")[0] ?? "";

    const res = await app.inject({
      method: "GET",
      url: `/auth/google/callback?code=fake-code&state=${stateValue}`,
      cookies: { udv_oauth_state: state?.value ?? "", udv_oauth_nonce: nonce?.value ?? "" },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("oauth=ok");
    expect(res.cookies.find((c) => c.name === "udv_rt")).toBeTruthy();

    const user = await db.user.findUnique({ where: { email: fakes.googleProfile.email } });
    expect(user?.googleId).toBe(fakes.googleProfile.sub);
    expect(user?.emailVerified).toBe(true);
  });

  it("state errado → redireciona com erro, sem criar user", async () => {
    const start = await app.inject({ method: "GET", url: "/auth/google/start" });
    const state = start.cookies.find((c) => c.name === "udv_oauth_state");
    const res = await app.inject({
      method: "GET",
      url: "/auth/google/callback?code=fake-code&state=state-forjado",
      cookies: { udv_oauth_state: state?.value ?? "" },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("oauth=erro");
    expect(await db.user.count()).toBe(0);
  });

  it("state ausente → redireciona com erro, sem criar user", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/auth/google/callback?code=fake-code",
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("oauth=erro");
    expect(await db.user.count()).toBe(0);
  });

  it("email não verificado + user existente com mesmo email → erro, sem linkar googleId, sem cookie", async () => {
    const existing = await db.user.create({
      data: { email: "unverified@example.org", name: "Existing", emailVerified: true },
    });

    const res = await callbackWithProfile({
      sub: "google-sub-unverified",
      email: "unverified@example.org",
      emailVerified: false,
      name: "Attacker Controlled Name",
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("oauth=erro");
    expect(res.cookies.find((c) => c.name === "udv_rt")).toBeFalsy();

    const reloaded = await db.user.findUnique({ where: { id: existing.id } });
    expect(reloaded?.googleId).toBeNull();
  });

  it("email não verificado sem user existente → erro, nenhum user criado", async () => {
    const res = await callbackWithProfile({
      sub: "google-sub-new-unverified",
      email: "brand-new-unverified@example.org",
      emailVerified: false,
      name: "Nobody",
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("oauth=erro");
    expect(await db.user.count()).toBe(0);
  });

  it("email do google ausente/vazio → erro, nenhum user criado", async () => {
    const res = await callbackWithProfile({
      sub: "google-sub-empty-email",
      email: "",
      emailVerified: true,
      name: "No Email",
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("oauth=erro");
    expect(await db.user.count()).toBe(0);
  });
});
