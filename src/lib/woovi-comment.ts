/** Limite que a Woovi aceita no comentário da cobrança. */
const MAX_LENGTH = 140;

/** Pontuação tipográfica → ASCII. A Woovi trata travessão como emoji e recusa a cobrança. */
const TRANSLITERATIONS: Array<[RegExp, string]> = [
  [/[—–−]/g, "-"],
  [/[“”„]/g, '"'],
  [/[‘’‚]/g, "'"],
  [/…/g, "..."],
  [/[   ]/g, " "],
];

/**
 * Comentário seguro para uma cobrança Woovi.
 *
 * A Woovi recusa a cobrança inteira com `400 "Emoji não é permitido no comentário"` diante
 * de caracteres que ela classifica como emoji — e o travessão entra nessa conta, embora
 * acento não entre. Como o comentário é só um rótulo para o extrato de quem recebe, vale
 * mais aproximá-lo do que deixar a doação morrer no gateway.
 */
export function wooviComment(text: string): string {
  let out = text;
  for (const [pattern, replacement] of TRANSLITERATIONS) out = out.replace(pattern, replacement);
  // Sobrou o que a Woovi reconhece: latino acentuado, dígitos e pontuação comum.
  out = out.replace(/[^\p{Script=Latin}\p{Mark}0-9 .,;:!?()\-_/'"+&@#%$*=]/gu, "");
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_LENGTH);
}
