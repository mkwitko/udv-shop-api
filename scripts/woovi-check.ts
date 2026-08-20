/**
 * Diagnóstico de credencial da Woovi. Testa o AppID contra produção E sandbox, porque
 * "appID inválido" é a mesma mensagem para chave revogada e para chave do ambiente errado.
 *
 *   npx tsx --env-file=.env scripts/woovi-check.ts            # usa WOOVI_API_KEY do .env
 *   WOOVI_TEST_KEY=<appid> npx tsx scripts/woovi-check.ts     # testa uma chave nova
 *
 * Nunca imprime a chave inteira: só formato, tamanho e o que a Woovi respondeu.
 */
const AMBIENTES = [
  { nome: "produção", baseUrl: "https://api.woovi.com", painel: "app.woovi.com" },
  {
    nome: "teste (sandbox)",
    baseUrl: "https://api.woovi-sandbox.com",
    painel: "app.woovi-sandbox.com",
  },
];

const key = (process.env.WOOVI_TEST_KEY ?? process.env.WOOVI_API_KEY ?? "").trim();
if (!key) {
  console.error("Sem chave. Use WOOVI_TEST_KEY=<appid> ou --env-file=.env com WOOVI_API_KEY.");
  process.exit(1);
}

console.log("── formato da chave ──");
console.log("tamanho:", key.length);
let decoded: string | null = null;
try {
  decoded = Buffer.from(key, "base64").toString("utf8");
} catch {
  decoded = null;
}
const partes = decoded?.split(":") ?? [];
if (partes.length === 2 && partes[0]?.startsWith("Client_Id_")) {
  console.log("estrutura: OK — base64 de Client_Id_…:Client_Secret_…");
  console.log("client_id:", `${partes[0].replace("Client_Id_", "").slice(0, 8)}…`);
} else {
  console.log("estrutura: SUSPEITA — o AppID da Woovi é o base64 de");
  console.log("           'Client_Id_<uuid>:Client_Secret_<segredo>'. Copie o AppID inteiro.");
}

for (const amb of AMBIENTES) {
  console.log(`\n── ${amb.nome} (${amb.baseUrl}) ──`);
  try {
    const res = await fetch(`${amb.baseUrl}/api/v1/subaccount`, {
      headers: { Authorization: key },
      signal: AbortSignal.timeout(15_000),
    });
    const texto = await res.text();
    console.log("HTTP", res.status, res.statusText);
    console.log("resposta:", texto.slice(0, 300));
    // 401/"appID inválido" é o único sinal de credencial errada. Qualquer outra
    // resposta — inclusive 400 de regra de negócio, como "empresa sem subconta" —
    // significa que a Woovi JÁ autenticou a chave neste ambiente.
    const recusada = res.status === 401 || texto.includes("appID inválido");
    if (recusada) {
      console.log(
        `✗ Credencial recusada aqui. Se você gerou a chave em ${amb.painel}, é o outro ambiente.`,
      );
    } else {
      console.log(`✓ Autenticou neste ambiente. Use WOOVI_BASE_URL=${amb.baseUrl} no .env.`);
    }
  } catch (err) {
    console.log("falha de rede:", err instanceof Error ? err.message : err);
  }
}
