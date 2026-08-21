// Seed de desenvolvimento: uma loja completa o bastante para o front ter o que renderizar
// (catálogo, campanha, sorteio, pedido pago, doação paga). Idempotente — pode rodar de novo.
// NUNCA rodar contra produção: cria usuários com senha conhecida.
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { config } from "dotenv";

export const SEED_PASSWORD = "senha-forte-123";
export const SEED_STORE_SLUG = "nucleo-demo";

export async function seedDatabase(db: PrismaClient): Promise<string> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("seed recusado: NODE_ENV=production");
  }

  const passwordHash = await argon2.hash(SEED_PASSWORD, { type: argon2.argon2id });

  const [admin, owner, staff, customer] = await Promise.all(
    [
      { email: "admin@udv.local", name: "Admin da Plataforma", platformAdmin: true },
      { email: "dono@nucleo.local", name: "Dono do Núcleo", platformAdmin: false },
      { email: "equipe@nucleo.local", name: "Equipe do Núcleo", platformAdmin: false },
      { email: "cliente@example.org", name: "Cliente Demo", platformAdmin: false },
    ].map((u) =>
      db.user.upsert({
        where: { email: u.email },
        update: { name: u.name, platformAdmin: u.platformAdmin, emailVerified: true },
        create: { ...u, passwordHash, emailVerified: true },
      }),
    ),
  );
  if (!admin || !owner || !staff || !customer) throw new Error("seed: usuários não criados");

  const store = await db.store.upsert({
    where: { slug: SEED_STORE_SLUG },
    update: { status: "active", wooviPixKey: "demo@prospera.fake" },
    create: {
      slug: SEED_STORE_SLUG,
      name: "Núcleo Demonstração",
      description: "Loja de exemplo para desenvolvimento do front.",
      status: "active",
      // sem comissão por venda: a plataforma vive da mensalidade (ADR-027)
      applicationFeeBps: 0,
      // sem conta conectada: id inventado passava pelas nossas checagens e só quebrava
      // no Stripe, com 502 na cara de quem tentava doar no cartão. A loja de exemplo
      // nasce como qualquer loja nova — cartão só depois do onboarding em Recebimento.
      // chave Pix fictícia: com DEV_FAKE_PAYMENTS=true o checkout Pix funciona inteiro
      wooviPixKey: "demo@prospera.fake",
    },
  });

  for (const [userId, role] of [
    [owner.id, "owner"],
    [staff.id, "staff"],
  ] as const) {
    await db.userStoreRole.upsert({
      where: { userId_storeId: { userId, storeId: store.id } },
      update: { role },
      create: { userId, storeId: store.id, role },
    });
  }

  // Gavetas da vitrine, incluindo uma vazia de propósito: a gestão precisa vê-la e a
  // vitrine não pode desenhá-la.
  const categoryNames = [
    { slug: "vestuario", name: "Vestuário", position: 0 },
    { slug: "casa", name: "Casa", position: 1 },
    { slug: "leitura", name: "Leitura", position: 2 },
    { slug: "sementes", name: "Sementes", position: 3 },
    // gaveta sem produto: existe na gestão, não aparece na vitrine
    { slug: "cozinha", name: "Cozinha", position: 4 },
  ];
  const categories = new Map<string, string>();
  for (const category of categoryNames) {
    const saved = await db.productCategory.upsert({
      where: { storeId_slug: { storeId: store.id, slug: category.slug } },
      update: { name: category.name, position: category.position },
      create: { ...category, storeId: store.id },
    });
    categories.set(category.slug, saved.id);
  }

  const products = [
    {
      slug: "camiseta-uniao",
      name: "Camiseta União",
      description: "Algodão, estampa serigrafada.",
      priceCents: 8900,
      stock: 12,
      availability: "in_stock" as const,
      active: true,
      category: "vestuario",
    },
    {
      slug: "caneca-esperanca",
      name: "Caneca Esperança",
      description: "Porcelana 300ml.",
      priceCents: 4500,
      stock: 3,
      availability: "in_stock" as const,
      active: true,
      category: "casa",
    },
    {
      slug: "livro-doutrina",
      name: "Livro de Doutrina",
      description: "Encomenda sob demanda, prazo de 20 dias.",
      priceCents: 12000,
      stock: 0,
      availability: "on_demand" as const,
      active: true,
      category: "leitura",
    },
    {
      slug: "chaveiro-antigo",
      name: "Chaveiro (fora de linha)",
      description: "Produto inativo — não deve aparecer no catálogo público.",
      priceCents: 1500,
      stock: 0,
      availability: "in_stock" as const,
      active: false,
      category: "casa",
    },
    // volume suficiente para exercitar paginação, busca e ordenação na vitrine
    {
      slug: "cha-de-hortela",
      name: "Chá de hortelã da horta comunitária",
      description: "Folhas colhidas e secas no núcleo, embalagem de 40g.",
      priceCents: 2200,
      stock: 30,
      availability: "in_stock" as const,
      active: true,
      category: "casa",
    },
    {
      slug: "mel-silvestre",
      name: "Mel silvestre",
      description: "Colhido na mata do núcleo, vidro de 500g.",
      priceCents: 4800,
      stock: 8,
      availability: "in_stock" as const,
      active: true,
      category: "casa",
    },
    {
      slug: "cesto-de-palha",
      name: "Cesto de palha trançado à mão",
      description: "Trançado por Dona Ana, dois tamanhos.",
      priceCents: 15900,
      stock: 4,
      availability: "in_stock" as const,
      active: true,
      category: "casa",
    },
    {
      slug: "moletom-colheita",
      name: "Moletom Colheita",
      description: "Moletom flanelado, bordado no peito.",
      priceCents: 18900,
      stock: 6,
      availability: "in_stock" as const,
      active: true,
      category: "vestuario",
    },
    {
      slug: "bone-uniao",
      name: "Boné União",
      description: "Aba curva, bordado.",
      priceCents: 6500,
      stock: 0,
      availability: "in_stock" as const,
      active: true,
      category: "vestuario",
    },
    {
      slug: "caderno-de-hinos",
      name: "Caderno de hinos com capa de tecido",
      description: "Costurado à mão, 120 páginas pautadas.",
      priceCents: 7500,
      stock: 15,
      availability: "in_stock" as const,
      active: true,
      category: "leitura",
    },
    {
      slug: "muda-de-jagube",
      name: "Muda de jagube",
      description: "Retirada apenas no núcleo, sob encomenda.",
      priceCents: 3500,
      stock: 0,
      availability: "on_demand" as const,
      active: true,
      category: "sementes",
    },
    {
      slug: "vela-artesanal",
      name: "Vela artesanal de cera de abelha com pavio de algodão trançado",
      description: "Nome longo de propósito: o card precisa aguentar duas linhas.",
      priceCents: 3900,
      stock: 22,
      availability: "in_stock" as const,
      active: true,
      category: null,
    },
  ];

  const saved = [];
  for (const { category, ...p } of products) {
    const categoryId = category ? (categories.get(category) ?? null) : null;
    saved.push(
      await db.product.upsert({
        where: { storeId_slug: { storeId: store.id, slug: p.slug } },
        update: { ...p, categoryId },
        create: { ...p, categoryId, storeId: store.id },
      }),
    );
  }

  // Parceira que recebe repasse: metade da camiseta, valor fixo na caneca.
  const supplier = await db.supplier.upsert({
    where: { storeId_name: { storeId: store.id, name: "Dona Ana" } },
    update: {},
    create: {
      storeId: store.id,
      name: "Dona Ana",
      phone: "48999995678",
      pixKey: "ana@example.org",
      note: "Costura as camisetas e pinta as canecas.",
    },
  });
  await db.product.update({
    where: { storeId_slug: { storeId: store.id, slug: "camiseta-uniao" } },
    data: { supplierId: supplier.id, payoutKind: "percent_bps", payoutValue: 5000 },
  });
  await db.product.update({
    where: { storeId_slug: { storeId: store.id, slug: "caneca-esperanca" } },
    data: { supplierId: supplier.id, payoutKind: "fixed_cents", payoutValue: 2000 },
  });

  const campaign = await db.campaign.upsert({
    where: { storeId_slug: { storeId: store.id, slug: "reforma-do-templo" } },
    update: { status: "active" },
    create: {
      storeId: store.id,
      slug: "reforma-do-templo",
      title: "Reforma do Templo",
      story: "Vamos trocar o telhado antes das chuvas.",
      goalCents: 5_000_000,
      acceptedTypes: "both",
      status: "active",
    },
  });

  const raffle = await db.raffle.upsert({
    where: { campaignId_sequence: { campaignId: campaign.id, sequence: 1 } },
    update: {},
    create: {
      campaignId: campaign.id,
      sequence: 1,
      title: "Sorteio da reforma",
      startsAt: new Date("2026-01-01T00:00:00Z"),
      centsPerNumber: 1000,
      status: "open",
    },
  });

  for (const [position, title] of [
    [1, "Cesta artesanal"],
    [2, "Camiseta União"],
  ] as const) {
    await db.rafflePrize.upsert({
      where: { raffleId_position: { raffleId: raffle.id, position } },
      update: { title },
      create: { raffleId: raffle.id, position, title },
    });
  }

  // Movimento só na primeira execução: pedido e doação não têm chave natural para upsert.
  const hasMovement = await db.order.count({ where: { storeId: store.id } });
  if (hasMovement === 0) {
    const shirt = saved[0];
    if (!shirt) throw new Error("seed: produto base não criado");
    const order = await db.order.create({
      data: {
        storeId: store.id,
        userId: customer.id,
        status: "paid",
        totalCents: shirt.priceCents,
        contactPhone: "+5511999990000",
        expiresAt: new Date("2026-01-01T00:00:00Z"),
        items: {
          create: [
            {
              productId: shirt.id,
              name: shirt.name,
              priceCents: shirt.priceCents,
              qty: 1,
              // repasse congelado na venda: metade da camiseta é da Dona Ana
              supplierId: supplier.id,
              payoutCents: Math.floor(shirt.priceCents / 2),
            },
          ],
        },
      },
    });
    await db.payment.create({
      data: {
        orderId: order.id,
        provider: "stripe",
        providerId: "pi_seed_order",
        amountCents: order.totalCents,
        applicationFeeCents: Math.round((order.totalCents * store.applicationFeeBps) / 10_000),
        status: "succeeded",
      },
    });

    const donation = await db.donation.create({
      data: {
        storeId: store.id,
        campaignId: campaign.id,
        userId: customer.id,
        type: "one_time",
        amountCents: 30_000,
        status: "paid",
        message: "Que a obra ande bem.",
        raffleGranted: true,
        paidAt: new Date("2026-02-01T00:00:00Z"),
      },
    });
    await db.payment.create({
      data: {
        donationId: donation.id,
        provider: "stripe",
        providerId: "pi_seed_donation",
        amountCents: donation.amountCents,
        applicationFeeCents: 0,
        status: "succeeded",
      },
    });

    const numbers = Math.floor(donation.amountCents / raffle.centsPerNumber);
    await db.raffleEntry.createMany({
      data: Array.from({ length: numbers }, (_, i) => ({
        raffleId: raffle.id,
        donationId: donation.id,
        userId: customer.id,
        number: raffle.nextNumber + i,
      })),
    });
    await db.raffle.update({
      where: { id: raffle.id },
      data: { nextNumber: raffle.nextNumber + numbers },
    });
  }

  return [
    `loja: ${store.slug} (${store.status})`,
    `produtos: ${saved.length}`,
    `campanha: ${campaign.slug} + sorteio ${raffle.status}`,
    `login: admin@udv.local / dono@nucleo.local / equipe@nucleo.local / cliente@example.org`,
    `senha: ${SEED_PASSWORD}`,
  ].join("\n");
}

// Só executa quando chamado como script (`pnpm db:seed`); importar o módulo não semeia nada.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  config({ path: ".env" });
  const db = new PrismaClient();
  try {
    console.log(await seedDatabase(db));
  } finally {
    await db.$disconnect();
  }
}
