import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/infra/db/client.js";
import { resetDb } from "../helpers/db.js";
import { buildFakeGateways, type FakeGateways } from "../mocks/gateways.fake.js";

const PIX = "pix@nucleo.org";

/**
 * Prova de posse da chave Pix. A loja paga R$ 0,01 para a plataforma DA CONTA DA CHAVE, e o
 * webhook diz de quem é a conta que pagou. É o que separa "declarei uma chave" de "essa
 * chave é minha" — sem isso, alguém cadastra a chave de um terceiro e as vendas caem na
 * conta de um inocente, com a trilha do golpe apontando para ele.
 */
describe("prova de posse da chave Pix", () => {
  let app: FastifyInstance;
  let gateways: FakeGateways;

  beforeAll(async () => {
    gateways = buildFakeGateways();
    app = await buildApp({ gateways });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    gateways.wooviSubAccounts.length = 0;
    gateways.wooviCharges.length = 0;
    gateways.wooviPlainCharges.length = 0;
    gateways.wooviPixKeyOwners.clear();
    gateways.wooviPixKeyUnknown.clear();
  });

  async function ownerToken(email: string, slug = "nx") {
    const store = await db.store.create({ data: { slug, name: "Núcleo X", status: "active" } });
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Pessoa", email, password: "senha-forte-123" },
    });
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    await db.userStoreRole.create({ data: { userId: user.id, storeId: store.id, role: "owner" } });
    const cookie = res.cookies.find((c) => c.name === "udv_rt")?.value ?? "";
    const refreshed = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { udv_rt: cookie },
    });
    return { store, token: refreshed.json().accessToken as string };
  }

  function saveKey(token: string, pixKey = PIX, slug = "nx") {
    return app.inject({
      method: "PUT",
      url: `/stores/${slug}/connect/woovi`,
      headers: { authorization: `Bearer ${token}` },
      payload: { pixKey },
    });
  }

  function startProof(token: string, slug = "nx") {
    return app.inject({
      method: "POST",
      url: `/stores/${slug}/connect/woovi/verification`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  /** Webhook de cobrança paga, como a Woovi manda: o pagador vem em `pix.payer`. */
  function chargePaid(correlationID: string, payer: { name: string; taxID: string }) {
    return app.inject({
      method: "POST",
      url: "/webhooks/woovi",
      headers: { "x-openpix-signature": "ok", "content-type": "application/json" },
      payload: JSON.stringify({
        event: "OPENPIX:CHARGE_COMPLETED",
        charge: { correlationID },
        pix: { payer: { name: payer.name, taxID: { taxID: payer.taxID, type: "BR:CPF" } } },
      }),
    });
  }

  it("chave que o Banco Central não conhece é recusada na hora, sem subconta", async () => {
    const { token } = await ownerToken("owner-dict@example.org");
    gateways.wooviPixKeyUnknown.add("errado@nucleo.org");

    const res = await saveKey(token, "errado@nucleo.org");

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("woovi_pix_key_not_found");
    expect(gateways.wooviSubAccounts).toEqual([]);
  });

  it("chave salva nasce pending e não recebe: nem checkout Pix, nem doação", async () => {
    const { store, token } = await ownerToken("owner-pending@example.org");
    await saveKey(token);

    const persisted = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(persisted.wooviPixKeyStatus).toBe("pending");
    expect(persisted.wooviPixKeyVerifiedAt).toBeNull();
    // o dono consultado no DICT fica guardado: é com ele que o pagador é comparado
    expect(persisted.wooviPixKeyOwnerName).toBe("Dona da Chave");

    const produto = await db.product.create({
      data: { storeId: store.id, slug: "cha", name: "Chá", priceCents: 1000, stock: 5 },
    });
    const compra = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        storeSlug: "nx",
        provider: "woovi",
        items: [{ productSlug: produto.slug, qty: 1 }],
        contact: { name: "Cliente", phone: "48999995678" },
      },
    });
    expect(compra.statusCode).toBe(400);
    expect(compra.json().message).toBe("payments_not_configured");
    expect(gateways.wooviCharges).toEqual([]);
  });

  it("centavo pago pelo dono da chave verifica, e aí a loja recebe", async () => {
    const { store, token } = await ownerToken("owner-ok@example.org");
    await saveKey(token);

    const proof = await startProof(token);
    expect(proof.statusCode).toBe(200);
    expect(proof.json()).toMatchObject({
      status: "pending",
      amountCents: 1,
      ownerName: "Dona da Chave",
    });
    // cobrança SEM split: o centavo fica na plataforma. Com split ele voltaria para a
    // subconta da chave que ainda não foi provada.
    expect(gateways.wooviPlainCharges).toHaveLength(1);
    expect(gateways.wooviCharges).toHaveLength(0);
    const correlationID = gateways.wooviPlainCharges[0]?.correlationID as string;

    // dona da chave é 000.***.***-91 no DICT falso; este CPF bate com a máscara
    const hook = await chargePaid(correlationID, { name: "Dona da Chave", taxID: "00000000191" });
    expect(hook.statusCode).toBe(200);

    const persisted = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(persisted.wooviPixKeyStatus).toBe("verified");
    expect(persisted.wooviPixKeyVerifiedAt).not.toBeNull();
    const verification = await db.wooviPixKeyVerification.findFirstOrThrow({
      where: { storeId: store.id },
    });
    expect(verification.status).toBe("verified");
    // documento de quem pagou fica mascarado: auditar a tentativa não pede o número inteiro
    expect(verification.payerTaxIdMasked).toBe("000******91");
  });

  it("centavo pago por outro CPF recusa: é a chave de terceiro que a prova barra", async () => {
    const { store, token } = await ownerToken("owner-fantoche@example.org");
    await saveKey(token);
    await startProof(token);
    const correlationID = gateways.wooviPlainCharges[0]?.correlationID as string;

    await chargePaid(correlationID, { name: "Outra Pessoa", taxID: "11122233344" });

    const persisted = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(persisted.wooviPixKeyStatus).toBe("pending");
    expect(persisted.wooviPixKeyVerifiedAt).toBeNull();
    const verification = await db.wooviPixKeyVerification.findFirstOrThrow({
      where: { storeId: store.id },
    });
    expect(verification.status).toBe("rejected");
  });

  it("pedir a prova duas vezes devolve a MESMA cobrança: o QR já está aberto num celular", async () => {
    const { token } = await ownerToken("owner-mesma@example.org");
    await saveKey(token);

    const first = await startProof(token);
    const second = await startProof(token);

    expect(second.json().brCode).toBe(first.json().brCode);
    expect(gateways.wooviPlainCharges).toHaveLength(1);
  });

  it("trocar de chave depois de provar volta para pending: a prova era da chave antiga", async () => {
    const { store, token } = await ownerToken("owner-troca@example.org");
    await saveKey(token);
    await startProof(token);
    await chargePaid(gateways.wooviPlainCharges[0]?.correlationID as string, {
      name: "Dona da Chave",
      taxID: "00000000191",
    });

    await saveKey(token, "outra@nucleo.org");

    const persisted = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(persisted.wooviPixKey).toBe("outra@nucleo.org");
    expect(persisted.wooviPixKeyStatus).toBe("pending");
    expect(persisted.wooviPixKeyVerifiedAt).toBeNull();
  });

  it("centavo que chega depois da troca de chave não vale para a chave nova", async () => {
    const { store, token } = await ownerToken("owner-atrasado@example.org");
    await saveKey(token);
    await startProof(token);
    const correlationID = gateways.wooviPlainCharges[0]?.correlationID as string;
    // pediu a prova, trocou a chave, e só então o centavo da chave antiga foi pago
    await saveKey(token, "outra@nucleo.org");

    await chargePaid(correlationID, { name: "Dona da Chave", taxID: "00000000191" });

    const persisted = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(persisted.wooviPixKeyStatus).toBe("pending");
    const verification = await db.wooviPixKeyVerification.findFirstOrThrow({
      where: { id: correlationID },
    });
    expect(verification.status).toBe("expired");
  });

  it("chave legada (de antes da verificação) recebe, e a tela sabe que ainda falta provar", async () => {
    const { store, token } = await ownerToken("owner-legada@example.org");
    await db.store.update({
      where: { id: store.id },
      data: { wooviPixKey: PIX, wooviPixKeyStatus: "legacy" },
    });

    const status = await app.inject({
      method: "GET",
      url: "/stores/nx/connect",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status.json().woovi.keyStatus).toBe("legacy");

    const produto = await db.product.create({
      data: { storeId: store.id, slug: "cha", name: "Chá", priceCents: 1000, stock: 5 },
    });
    const compra = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        storeSlug: "nx",
        provider: "woovi",
        items: [{ productSlug: produto.slug, qty: 1 }],
        contact: { name: "Cliente", phone: "48999995678" },
      },
    });
    // tirar do ar quem já vendia seria pior que o risco: recebe, com aviso na gestão
    expect(compra.statusCode).toBe(201);
  });

  it("chave já provada não abre outra cobrança", async () => {
    const { store, token } = await ownerToken("owner-provada@example.org");
    await db.store.update({
      where: { id: store.id },
      data: { wooviPixKey: PIX, wooviPixKeyStatus: "verified", wooviPixKeyVerifiedAt: new Date() },
    });

    const res = await startProof(token);

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe("pix_key_already_verified");
    expect(gateways.wooviPlainCharges).toEqual([]);
  });
});
