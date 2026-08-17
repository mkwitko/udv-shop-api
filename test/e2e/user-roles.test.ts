import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { verifyAccessToken } from "../../src/lib/jwt.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

describe("roles por loja no token", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ gateways: buildFakeGateways() });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it("refresh emite claims com role da loja", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Dona", email: "dona@example.org", password: "senha-forte-123" },
    });
    const rt = reg.cookies.find((c) => c.name === "udv_rt");
    const user = await db.user.findUniqueOrThrow({ where: { email: "dona@example.org" } });
    const store = await db.store.create({ data: { slug: "nucleo-x", name: "Núcleo X" } });
    await db.userStoreRole.create({ data: { userId: user.id, storeId: store.id, role: "owner" } });

    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { udv_rt: rt?.value ?? "" },
    });
    const claims = await verifyAccessToken(res.json().accessToken);
    expect(claims.roles[store.id]).toBe("owner");
  });
});
