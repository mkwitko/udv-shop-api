/**
 * Comparação entre o dono da chave Pix (DICT, via `POST /api/v1/pix-keys/check`) e quem
 * pagou o centavo da prova de posse (webhook da cobrança).
 *
 * O detalhe que manda no desenho: a Woovi devolve o CPF do dono MASCARADO
 * ("000.***.***-91") e o CNPJ inteiro. Já o pagador chega inteiro no webhook. Então a
 * comparação é posicional — os dígitos que a máscara revela têm de bater, um a um, com o
 * documento de quem pagou.
 */

/** Só dígitos. Serve para o documento inteiro do pagador e para a chave CPF/CNPJ. */
function digits(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Máscara reduzida a um padrão posicional: dígito onde a Woovi revelou, `*` onde escondeu.
 * "000.***.***-91" → "000******91" (11 posições, 5 conhecidas).
 */
function pattern(masked: string): string {
  return masked.replace(/[^0-9*]/g, "");
}

/** Abaixo disso a máscara não distingue pessoas o suficiente para decidir sozinha. */
const MIN_VISIBLE_DIGITS = 5;

export type TaxIdMatch =
  /** Todos os dígitos conhecidos batem: mesma pessoa (jurídica ou física). */
  | { result: "match" }
  /** Algum dígito conhecido difere, ou o tipo de documento nem é o mesmo. */
  | { result: "mismatch" }
  /**
   * A máscara revelou menos do que o mínimo, ou o formato mudou. NÃO é recusa: é a
   * plataforma admitindo que não sabe decidir, e isso precisa aparecer no log.
   */
  | { result: "inconclusive"; reason: string };

/**
 * Compara o documento do pagador com o do dono da chave.
 *
 * `ownerTaxId` pode vir mascarado (CPF) ou inteiro (CNPJ). Quando a chave É um CPF/CNPJ,
 * quem chama passa a própria chave como `ownerTaxId`: aí a comparação é exata, sem máscara
 * nenhuma no caminho.
 */
export function compareTaxId(ownerTaxId: string, payerTaxId: string): TaxIdMatch {
  const owner = pattern(ownerTaxId);
  const payer = digits(payerTaxId);

  if (payer.length !== 11 && payer.length !== 14) {
    return { result: "inconclusive", reason: "documento do pagador não é CPF nem CNPJ" };
  }
  // CPF não vira CNPJ por máscara: tamanho diferente é pessoa diferente, não dúvida.
  if (owner.length !== payer.length) return { result: "mismatch" };

  const visible = owner.replace(/\*/g, "").length;
  if (visible < MIN_VISIBLE_DIGITS) {
    return { result: "inconclusive", reason: `máscara revelou só ${visible} dígitos` };
  }

  for (let i = 0; i < owner.length; i++) {
    const known = owner[i] as string;
    if (known !== "*" && known !== payer[i]) return { result: "mismatch" };
  }
  return { result: "match" };
}

/**
 * Nome comparável: sem acento, sem pontuação, minúsculo, espaço único. Serve para
 * REGISTRO e alerta, não para decidir — banco abrevia nome ("MARIA S SILVA"), e recusar
 * uma chave que é da pessoa por causa de abreviação seria pior que o risco coberto.
 */
export function normalizeOwnerName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Documento do dono que vamos guardar para comparar depois.
 *
 * Quando a chave É o documento (tipo CPF ou CNPJ), a própria chave já nos dá o número
 * inteiro — e aí a comparação com o pagador é exata, não os 5 dígitos que a máscara do
 * DICT deixa ver. Nos outros tipos (e-mail, telefone, aleatória) sobra a máscara.
 */
export function ownerTaxIdOf(owner: { type: string; pixKey: string; taxId: string }): string {
  if (owner.type === "CPF" || owner.type === "CNPJ") {
    const chave = digits(owner.pixKey);
    if (chave.length === 11 || chave.length === 14) return chave;
  }
  return owner.taxId;
}

/** Máscara para gravar o documento de quem pagou sem guardar o documento de terceiro. */
export function maskTaxId(taxId: string): string {
  const value = digits(taxId);
  if (value.length < 5) return "***";
  return `${value.slice(0, 3)}${"*".repeat(value.length - 5)}${value.slice(-2)}`;
}
