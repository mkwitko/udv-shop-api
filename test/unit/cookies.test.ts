import { afterEach, describe, expect, it, vi } from "vitest";

async function loadCookies() {
  vi.resetModules();
  return import("../../src/http/api/auth/cookies.js");
}

describe("cookie de refresh — same-site vs cross-site", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("por padrão usa SameSite=lax e não força secure fora de produção", async () => {
    vi.stubEnv("COOKIE_CROSS_SITE", "");
    const { refreshCookieSameSite, refreshCookieSecure } = await loadCookies();
    expect(refreshCookieSameSite).toBe("lax");
    expect(refreshCookieSecure).toBe(false);
  });

  it("com COOKIE_CROSS_SITE=true usa SameSite=None e força secure", async () => {
    vi.stubEnv("COOKIE_CROSS_SITE", "true");
    const { refreshCookieSameSite, refreshCookieSecure } = await loadCookies();
    expect(refreshCookieSameSite).toBe("none");
    // SameSite=None sem Secure é descartado pelo navegador — os dois andam juntos.
    expect(refreshCookieSecure).toBe(true);
  });
});
