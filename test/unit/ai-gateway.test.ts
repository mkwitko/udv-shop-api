import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiGateway } from "../../src/gateways/ai/ai.gateway.js";

function stubFetch(): { messages: () => Array<{ role: string; content: string }> } {
  const calls: Array<{ role: string; content: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      calls.push(...body.messages);
      return new Response(JSON.stringify({ success: true, result: { response: "Texto." } }), {
        status: 200,
      });
    }),
  );
  return { messages: () => calls };
}

const gateway = () =>
  createAiGateway({ accountId: "acc", apiToken: "token", model: "@cf/meta/llama" });

afterEach(() => vi.unstubAllGlobals());

describe("persona de marketing", () => {
  it("os quatro textos vêm do mesmo especialista, com as proibições de cada um", async () => {
    const fetched = stubFetch();
    const ai = gateway();
    await ai.writeProductDescription({ productName: "Mel", mode: "create" });
    await ai.writeCampaignStory({ campaignTitle: "Reforma", mode: "create" });
    await ai.writePrizeDescription({ prizeTitle: "Cesta", mode: "create" });
    await ai.writeStoreDescription({ storeName: "Núcleo", mode: "create" });

    const systems = fetched.messages().filter((m) => m.role === "system");
    expect(systems).toHaveLength(4);
    for (const system of systems) {
      expect(system.content).toContain("especialista em marketing e vendas");
      // a persona não pode virar licença para inventar: a trava anda junto com ela
      expect(system.content).toContain("nunca inventa fato para vender");
    }
    // e cada texto mantém a proibição que é dele
    expect(systems[0]?.content).toContain("NÃO cite preço");
    expect(systems[1]?.content).toContain("NÃO prometa resultado");
    expect(systems[2]?.content).toContain("NÃO diga quanto o prêmio vale");
    expect(systems[3]?.content).toContain("NÃO invente ano de fundação");
  });
});

describe("instrução de quem escreve", () => {
  it("entra no prompt do usuário, depois do rascunho e subordinada às regras", async () => {
    const fetched = stubFetch();
    await gateway().writePrizeDescription({
      prizeTitle: "Cesta de produtos",
      mode: "improve",
      draft: "Café, mel e pão caseiro da nossa horta.",
      instruction: "Deixe mais curto e cite a horta.",
    });

    const [system, user] = fetched.messages();
    // as proibições continuam no system: a instrução não pode liberar preço nem marca
    expect(system?.content).toContain("NÃO invente marca");
    expect(user?.content).toContain("Deixe mais curto e cite a horta.");
    expect(user?.content).toContain("Pedido de quem escreve");
    expect(user?.content.indexOf("Pedido de quem escreve")).toBeGreaterThan(
      user?.content.indexOf("Café, mel e pão caseiro") ?? 0,
    );
  });

  it("sem instrução o prompt não ganha a seção", async () => {
    const fetched = stubFetch();
    await gateway().writePrizeDescription({ prizeTitle: "Cesta", mode: "create" });
    expect(fetched.messages()[1]?.content).not.toContain("Pedido de quem escreve");
  });

  it("vale para produto, história e loja também", async () => {
    const fetched = stubFetch();
    const ai = gateway();
    await ai.writeProductDescription({
      productName: "Mel",
      mode: "create",
      instruction: "Fale do sabor.",
    });
    await ai.writeCampaignStory({
      campaignTitle: "Reforma",
      mode: "create",
      instruction: "Sem drama.",
    });
    await ai.writeStoreDescription({
      storeName: "Núcleo",
      mode: "create",
      instruction: "Cite as quartas.",
    });

    const users = fetched.messages().filter((m) => m.role === "user");
    expect(users[0]?.content).toContain("Fale do sabor.");
    expect(users[1]?.content).toContain("Sem drama.");
    expect(users[2]?.content).toContain("Cite as quartas.");
  });

  it("instrução gigante é cortada antes de virar prompt", async () => {
    const fetched = stubFetch();
    await gateway().writePrizeDescription({
      prizeTitle: "Cesta",
      mode: "create",
      instruction: "a".repeat(500),
    });
    const user = fetched.messages()[1]?.content ?? "";
    expect(user).toContain("a".repeat(300));
    expect(user).not.toContain("a".repeat(301));
  });
});
