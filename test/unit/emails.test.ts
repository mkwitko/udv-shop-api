import { describe, expect, it } from "vitest";
import { resetPasswordHtml, verifyEmailHtml } from "../../src/http/api/auth/emails.js";

describe("transactional email templates", () => {
  it("escapes HTML-significant characters in the user name (verify email)", () => {
    const { html } = verifyEmailHtml("<img src=x onerror=alert(1)>&\"'", "tok");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;");
  });

  it("escapes HTML-significant characters in the user name (reset password)", () => {
    const { html } = resetPasswordHtml("<script>alert(1)</script>", "tok");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("still renders a normal name unescaped-looking", () => {
    const { html } = verifyEmailHtml("Maria", "tok");
    expect(html).toContain("Olá, Maria!");
  });
});
