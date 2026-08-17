import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { buildFakeGateways } from "../mocks/gateways.fake.js";

describe("gateways plugin", () => {
  it("usa fakes passados via opts", async () => {
    const fakes = buildFakeGateways();
    const app = await buildApp({ gateways: fakes });
    await app.ready();
    await app.gateways.email.send({ to: "a@b.c", subject: "oi", html: "<p>oi</p>" });
    expect(fakes.sentEmails).toHaveLength(1);
    await app.close();
  });
});
