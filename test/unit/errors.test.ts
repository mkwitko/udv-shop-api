import { describe, expect, it } from "vitest";
import { AppError, badGateway, ConflictError } from "../../src/shared/errors.js";

describe("errors", () => {
  it("subclasses carregam code e status", () => {
    const err = new ConflictError("email_in_use");
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("CONFLICT");
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe("email_in_use");
  });

  it("badGateway preserva cause", () => {
    const cause = new Error("upstream boom");
    const err = badGateway("resend_failed", cause);
    expect(err.statusCode).toBe(502);
    expect(err.cause).toBe(cause);
  });
});
