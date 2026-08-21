import { badGateway, ServiceUnavailableError } from "../../shared/errors.js";

export type DescriptionMode = "create" | "improve";

/**
 * Pedido em linguagem natural de quem está escrevendo ("mais curto", "cita a horta").
 * Entra no prompt do usuário, nunca no system: as proibições continuam mandando, então
 * "diga que vale R$ 300" não passa a valer só porque foi pedido no campo.
 */
export type WithInstruction = { instruction?: string | undefined };

export type WriteDescriptionInput = WithInstruction & {
  /** Nome do produto — é o único dado obrigatório para escrever do zero. */
  productName: string;
  /** O que a loja já escreveu. Em `improve` é o texto que vai ser reescrito. */
  draft?: string | undefined;
  mode: DescriptionMode;
  storeName?: string | undefined;
};

export type WriteStoryInput = WithInstruction & {
  /** Título da campanha. */
  campaignTitle: string;
  draft?: string | undefined;
  mode: DescriptionMode;
  storeName?: string | undefined;
  /** Meta em centavos, quando a campanha tem uma. Só contexto de tom. */
  goalCents?: number | undefined;
};

export type WritePrizeInput = WithInstruction & {
  /** O que é o prêmio, do jeito que a loja escreveu no campo de título. */
  prizeTitle: string;
  draft?: string | undefined;
  mode: DescriptionMode;
  storeName?: string | undefined;
  /** Campanha a que o sorteio pertence. Só contexto de tom. */
  campaignTitle?: string | undefined;
};

export type WriteStoreInput = WithInstruction & {
  /** Nome da loja/comunidade. Único dado obrigatório. */
  storeName: string;
  draft?: string | undefined;
  mode: DescriptionMode;
};

export type AiGateway = {
  /** `false` quando a feature não está configurada — a rota decide o que dizer. */
  readonly configured: boolean;
  writeProductDescription(input: WriteDescriptionInput): Promise<string>;
  /** História da campanha: por que arrecadar, no tom de quem organiza. */
  writeCampaignStory(input: WriteStoryInput): Promise<string>;
  /** Descrição do prêmio do sorteio: o que a pessoa leva se ganhar. */
  writePrizeDescription(input: WritePrizeInput): Promise<string>;
  /** Descrição da loja: quem é a comunidade, para a página e o compartilhamento. */
  writeStoreDescription(input: WriteStoreInput): Promise<string>;
};

export type AiGatewayConfig = {
  accountId: string;
  apiToken: string;
  model: string;
};

/** A descrição de produto aceita 5000 no banco; para a IA o teto é bem menor. */
const MAX_CHARS = 900;

/**
 * Persona comum aos quatro textos. Marketing aqui é técnica de escrita — abrir pelo que
 * a pessoa ganha, usar detalhe concreto, terminar com convite —, não licença para
 * exagerar: cada prompt repete as proibições logo depois, e elas mandam. A comunidade
 * assina esse texto, então promessa inventada custa a confiança dela, não a nossa.
 */
const PERSONA = [
  "Você é especialista em marketing e vendas e auxilia pequenos negócios de comunidade a",
  "vender melhor. Você abre pelo benefício concreto de quem lê, usa detalhe sensorial",
  "verdadeiro em vez de adjetivo vazio e fecha com um convite simples.",
  "Você nunca inventa fato para vender: o que não estiver no texto dado não entra.",
].join(" ");

/**
 * O preço NÃO entra no contexto de propósito: com ele no prompt o modelo escreve
 * "por R$ 45,00" no meio da descrição, que já aparece na página e desatualiza no
 * primeiro reajuste. Medido com llama-3.3 e llama-4 — os dois caem nessa.
 */
const SYSTEM_PROMPT = [
  PERSONA,
  "Agora você escreve como a própria loja, sobre um produto que ela vende.",
  "Escreva em português do Brasil correto, em tom simples, honesto e caloroso.",
  "Comece pelo que a pessoa ganha ao usar o produto e termine convidando a levar.",
  "Regras: 2 a 4 frases curtas (máximo ~70 palavras).",
  "NÃO cite preço, valor em reais, desconto, frete, prazo, garantia nem medida que",
  "não esteja no texto dado. NÃO invente material, origem, tamanho nem benefício.",
  "NÃO escreva como quem encontrou ou revende o produto: a loja é quem faz ou oferece.",
  "NÃO use emoji, hashtag, ALL CAPS, aspas nem promessa de saúde ou resultado.",
  "Responda só com o texto final, sem título e sem comentários.",
].join(" ");

/**
 * A história da campanha é pedido de doação, não anúncio: o risco aqui não é texto
 * sem graça, é texto que promete o que a comunidade não pode garantir.
 */
const STORY_SYSTEM_PROMPT = [
  PERSONA,
  "Agora você escreve como a própria comunidade, a história de uma campanha de arrecadação.",
  "Escreva em português do Brasil correto, no plural da comunidade (nós), em tom",
  "honesto e direto, sem apelo dramático e sem culpa.",
  "Diga logo o que a doação torna possível e termine convidando a participar.",
  "Regras: 3 a 5 frases curtas (máximo ~110 palavras).",
  "NÃO invente valor arrecadado, prazo, número de pessoas, obra, laudo, parceria nem",
  "destino do dinheiro que não esteja no texto dado.",
  "NÃO prometa resultado, cura, benefício fiscal nem contrapartida a quem doa.",
  "NÃO use emoji, hashtag, ALL CAPS nem aspas.",
  "Responda só com o texto final, sem título e sem comentários.",
].join(" ");

/** Teto da instrução no prompt; o schema da rota corta antes, isto é a última linha. */
const MAX_INSTRUCTION_CHARS = 300;

/**
 * A instrução vai por último e como pedido, não como regra: o modelo lê as proibições
 * primeiro e o texto de quem escreve depois. Cortar o tamanho evita que alguém cole um
 * prompt inteiro tentando reescrever as regras da casa.
 */
function withInstruction(lines: string[], instruction: string | undefined): string {
  const clean = instruction?.trim().slice(0, MAX_INSTRUCTION_CHARS);
  if (clean) {
    lines.push(
      "",
      "Pedido de quem escreve (atenda só no que não contrariar as regras acima).",
      // sem esta linha o modelo pequeno lê "mais curto" e devolve o mesmo tamanho: a
      // regra de frases é um intervalo, e ele fica no meio dele por padrão
      "Se o pedido for por texto mais curto, use o mínimo de frases que a regra permite:",
      clean,
    );
  }
  return lines.join("\n");
}

function storyPrompt(input: WriteStoryInput): string {
  const lines = [`Campanha: ${input.campaignTitle}`];
  if (input.storeName) lines.push(`Comunidade: ${input.storeName}`);
  if (input.mode === "improve" && input.draft) {
    lines.push(
      "",
      "Melhore a história abaixo mantendo TODOS os fatos que ela afirma — corrija o texto,",
      "não os fatos. Não acrescente informação nova.",
      "",
      input.draft,
    );
  } else {
    lines.push(
      "",
      "Escreva a história dessa campanha usando só o que está acima. Se faltar informação,",
      "fale do cuidado de quem organiza em vez de inventar detalhe.",
    );
    if (input.draft) lines.push("", `Anotação de quem organiza: ${input.draft}`);
  }
  return withInstruction(lines, input.instruction);
}

/**
 * Prêmio é o que mais tenta o modelo a inventar: marca, modelo, tamanho, "no valor de
 * R$ 300". Quem doou por causa do prêmio e recebeu outra coisa foi enganado — daí as
 * proibições serem mais duras que as da descrição de produto.
 */
const PRIZE_SYSTEM_PROMPT = [
  PERSONA,
  "Agora você escreve como a comunidade, sobre um prêmio que ela vai sortear entre quem doa.",
  "Escreva em português do Brasil correto, em tom simples e concreto.",
  "Faça a pessoa imaginar o prêmio na mão dela usando só o que foi dito sobre ele.",
  "Regras: 1 a 3 frases curtas (máximo ~50 palavras).",
  "NÃO invente marca, modelo, tamanho, cor, quantidade, validade nem valor em reais",
  "que não esteja no texto dado. NÃO diga quanto o prêmio vale.",
  "NÃO prometa entrega, prazo, frete nem troca.",
  "NÃO use emoji, hashtag, ALL CAPS nem aspas.",
  "Responda só com o texto final, sem título e sem comentários.",
].join(" ");

/**
 * Descrição da loja fala de quem é a comunidade. Data de fundação, número de membros e
 * histórico são exatamente o que o modelo inventa se deixarem.
 */
const STORE_SYSTEM_PROMPT = [
  PERSONA,
  "Agora você escreve como a própria loja de uma comunidade se apresentando na página dela.",
  "Escreva em português do Brasil correto, em tom acolhedor e sóbrio.",
  "Diga o que a pessoa encontra ali e por que vale comprar dessa comunidade.",
  "Regras: 2 a 3 frases curtas (máximo ~60 palavras).",
  "NÃO invente ano de fundação, número de pessoas, cidade, história, prêmio,",
  "certificação nem produto que não esteja no texto dado.",
  "NÃO prometa resultado, cura nem benefício fiscal.",
  "NÃO use emoji, hashtag, ALL CAPS nem aspas.",
  "Responda só com o texto final, sem título e sem comentários.",
].join(" ");

function prizePrompt(input: WritePrizeInput): string {
  const lines = [`Prêmio: ${input.prizeTitle}`];
  if (input.campaignTitle) lines.push(`Campanha: ${input.campaignTitle}`);
  if (input.storeName) lines.push(`Comunidade: ${input.storeName}`);
  if (input.mode === "improve" && input.draft) {
    lines.push(
      "",
      "Melhore a descrição abaixo mantendo TODOS os fatos que ela afirma — corrija o texto,",
      "não os fatos. Não acrescente informação nova.",
      "",
      input.draft,
    );
  } else {
    lines.push(
      "",
      "Descreva esse prêmio usando só o que está acima. Se faltar detalhe, diga o que a",
      "pessoa recebe em vez de inventar característica.",
    );
    if (input.draft) lines.push("", `Anotação de quem organiza: ${input.draft}`);
  }
  return withInstruction(lines, input.instruction);
}

function storePrompt(input: WriteStoreInput): string {
  const lines = [`Loja: ${input.storeName}`];
  if (input.mode === "improve" && input.draft) {
    lines.push(
      "",
      "Melhore a descrição abaixo mantendo TODOS os fatos que ela afirma — corrija o texto,",
      "não os fatos. Não acrescente informação nova.",
      "",
      input.draft,
    );
  } else {
    lines.push(
      "",
      "Escreva a descrição dessa loja usando só o que está acima. Se faltar informação,",
      "fale do cuidado de quem atende em vez de inventar detalhe.",
    );
    if (input.draft) lines.push("", `Anotação da loja: ${input.draft}`);
  }
  return withInstruction(lines, input.instruction);
}

function userPrompt(input: WriteDescriptionInput): string {
  const lines = [`Produto: ${input.productName}`];
  if (input.storeName) lines.push(`Loja: ${input.storeName}`);
  if (input.mode === "improve" && input.draft) {
    lines.push(
      "",
      "Melhore a descrição abaixo mantendo TODOS os fatos que ela afirma — corrija o texto,",
      "não os fatos. Não acrescente informação nova.",
      "",
      input.draft,
    );
  } else {
    lines.push(
      "",
      "Escreva a descrição desse produto usando só o que está acima.",
      "Se faltar informação, fale do cuidado de quem faz em vez de inventar detalhe.",
    );
    if (input.draft) lines.push("", `Anotação da loja: ${input.draft}`);
  }
  return withInstruction(lines, input.instruction);
}

/** Modelo devolve texto solto: tira cerca de código, aspas de moldura e sobra de prompt. */
function cleanUp(raw: string): string {
  const text = raw
    .replace(/^```[a-z]*\n?|```$/g, "")
    .replace(/^\s*(descrição|description)\s*:\s*/i, "")
    .trim()
    .replace(/^["'“”](.*)["'“”]$/s, "$1")
    .trim();
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS).trimEnd()}…` : text;
}

type WorkersAiResponse = {
  success?: boolean;
  result?: { response?: string };
  errors?: Array<{ message?: string }>;
};

/**
 * Workers AI da Cloudflare pela API REST (não precisa rodar dentro de um Worker).
 * Escolhido por já existir conta Cloudflare no projeto (R2) e ter cota diária grátis:
 * a feature é conveniência, então ficar sem cota não pode derrubar o cadastro de produto
 * — a rota devolve 503 e a tela segue com o texto que a pessoa escreveu.
 */
export function createAiGateway(config: AiGatewayConfig): AiGateway {
  const configured = Boolean(config.accountId && config.apiToken);

  async function complete(system: string, user: string, maxTokens: number): Promise<string> {
    if (!configured) throw new ServiceUnavailableError("ai_not_configured");

    const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/run/${config.model}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          max_tokens: maxTokens,
          temperature: 0.6,
        }),
        // texto curto: se demorar mais que isso, a tela espera demais por nada
        signal: AbortSignal.timeout(20_000),
      });
    } catch (cause) {
      throw badGateway("ai_unavailable", cause);
    }

    const body = (await res.json().catch(() => ({}))) as WorkersAiResponse;
    // 429 é cota diária estourada — não é erro da loja, e a tela precisa distinguir
    if (res.status === 429) throw new ServiceUnavailableError("ai_quota_exceeded");
    if (!res.ok || body.success === false) {
      throw badGateway("ai_unavailable", body.errors ?? res.statusText);
    }

    const text = cleanUp(body.result?.response ?? "");
    if (!text) throw badGateway("ai_empty_response", body);
    return text;
  }

  return {
    configured,
    writeProductDescription: (input) => complete(SYSTEM_PROMPT, userPrompt(input), 320),
    writeCampaignStory: (input) => complete(STORY_SYSTEM_PROMPT, storyPrompt(input), 420),
    writePrizeDescription: (input) => complete(PRIZE_SYSTEM_PROMPT, prizePrompt(input), 220),
    writeStoreDescription: (input) => complete(STORE_SYSTEM_PROMPT, storePrompt(input), 260),
  };
}
