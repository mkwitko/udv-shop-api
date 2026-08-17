import { createHash } from "node:crypto";

export const RAFFLE_ALGORITHM = "sha256-counter-v1";

/**
 * Sorteio auditável: qualquer pessoa com a seed publicada e a lista pública de números
 * refaz esta conta e confere os vencedores.
 *
 * Para o prêmio da posição `p` (1-based): sha256(`${seed}:${p}`), os 8 primeiros bytes
 * lidos como inteiro big-endian, módulo o tamanho do pool restante — o índice resultante
 * aponta para o pool ORDENADO por número crescente. O vencedor sai do pool, então
 * ninguém leva dois prêmios.
 *
 * O viés de módulo aqui é da ordem de pool/2^64 — irrelevante para qualquer sorteio real
 * e o preço de um algoritmo que cabe em cinco linhas e é conferível na mão.
 */
export function drawWinners(seed: string, entryNumbers: number[], prizeCount: number): number[] {
  const pool = [...entryNumbers].sort((a, b) => a - b);
  const winners: number[] = [];
  for (let position = 1; position <= prizeCount && pool.length > 0; position++) {
    const digest = createHash("sha256").update(`${seed}:${position}`).digest();
    const index = Number(digest.readBigUInt64BE(0) % BigInt(pool.length));
    const winner = pool[index];
    if (winner === undefined) break;
    winners.push(winner);
    pool.splice(index, 1);
  }
  return winners;
}
