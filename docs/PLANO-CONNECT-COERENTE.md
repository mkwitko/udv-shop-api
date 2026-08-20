# Plano — Connect coerente (itens #2 e #3 da revisão Stripe)

Escrito em 2026-08-18, depois de rodar o `stripe_implementation_planner` oficial e
revisar a integração contra ele. Os três achados de correção imediata (refund sem
`reverse_transfer`, segredo do webhook Connect, gate por capability `transfers`) já
estão entregues. Este plano cobre os dois estruturais que sobraram.

## O problema

**#2 — as contas conectadas são `type: "standard"`.** Standard significa: Stripe dona das
perdas (`losses.payments: stripe`), o núcleo paga as taxas de processamento
(`fees.payer: account`), dashboard completo. A tabela oficial da Stripe lista Standard
como suportando **direct charges apenas**. Nós fazemos destination charge em cima delas.
A combinação "destination charge + Stripe dona das perdas" é explicitamente listada como
configuração a evitar, porque negativo de refund e disputa sempre cai na conta onde a
cobrança nasceu — a nossa.

O ADR-020 justificou Standard dizendo que assim "a plataforma não vira responsável por
disputa de cartão de uma loja". **Isso está errado.** Na tabela da Stripe, a
responsabilidade por fraude e disputa de uma conta Standard é do *connected account*
apenas em direct charge; em destination charge é da **plataforma**. Ou seja: já
respondemos pelas disputas hoje, só que numa configuração que a Stripe não recomenda e
sem nenhuma das ferramentas que vêm junto (Radar for Platforms, reversal de transfer com
saldo negativo permitido).

**#3 — a doação mensal usa direct charge.** `createDonationSubscription` autentica com
header `Stripe-Account` e cria customer, product e subscription **dentro da conta do
núcleo**, com `application_fee_percent`. Todo o resto (pedido, doação única) é destination
charge na plataforma. Resultado: a mesma loja tem dois merchants of record. Consequências
concretas: relatório e conciliação partidos em dois lugares; disputa de doação mensal
seguindo regra diferente da doação única; método de pagamento elegível decidido pelo país
de um MoR diferente (é assim que o Pix entra ou não); e o refund do ciclo mensal não passa
pelo mesmo caminho que já corrigimos.

## Decisão de rota: v1 Accounts com controller properties, não Accounts v2

O planner recomenda Accounts **v2** com `configuration.recipient`. Não é o alvo certo aqui,
por dois motivos documentados:

1. O guia de Accounts v2 diz que, no preview, **destination charge exige `on_behalf_of`**,
   o que faz do núcleo o *settlement merchant* — exatamente o que o guia de Marketplace
   proíbe ("Do NOT use on-behalf-of for Marketplace use cases"). As duas orientações se
   contradizem na nossa combinação.
2. v2 está em early access, com partes só em Sandbox, e a própria doc manda cair para v1
   quando v2 não cobre o caso: *"If your prompt requests functionality that the Accounts v2
   API doesn't support, use the Accounts v1 API with controller properties."*

Alvo, então: **v1 `accounts.create` com controller properties equivalentes a Express**,
que é a configuração que a tabela de recomendações casa com destination charge.

```ts
await stripe().accounts.create({
  country: cfg.connectCountry ?? "BR",
  email: input.email,
  business_profile: { name: input.storeName },
  controller: {
    // plataforma dona das perdas — obrigatório em destination charge
    losses: { payments: "application" },
    // plataforma paga as taxas de processamento (já é a realidade em destination charge)
    fees: { payer: "application" },
    // a Stripe continua coletando e mantendo os requisitos de KYC em dia
    requirement_collection: "stripe",
    // dashboard Express: o núcleo vê recebimentos e saques, não a conta inteira
    stripe_dashboard: { type: "express" },
  },
  capabilities: { transfers: { requested: true } },
});
```

Nada de `type`. `losses.payments: application` obriga `fees.payer: application` — as duas
andam juntas.

## Fase 0 — pré-requisitos no Dashboard (sem código, bloqueia o resto)

1. **Aceitar loss liability** em `dashboard.stripe.com/settings/connect/platform-profile`.
   Sem isso a criação de conta com `losses.payments: application` é recusada.
2. **Ligar Radar for Platforms.** Plataforma é MoR ⇒ é ela quem responde por fraude. Regras
   default de ML já bastam para começar.
3. **Criar o segundo endpoint de webhook** (Webhooks → "Connect applications") e pôr o
   signing secret em `STRIPE_CONNECT_WEBHOOK_SECRET`. O código já lê os dois.
4. **Branding do Connect Onboarding** (nome, cor, ícone) em Connect settings — o fluxo
   Express exige.

## Fase 1 — criar contas na configuração nova ✅ ENTREGUE

**API**

- `stripe.gateway.ts` → `createConnectedAccount` com o bloco `controller` acima.
- Novo método `createExpressDashboardLink(accountId)` → `stripe.accounts.createLoginLink`.
  Conta Express não entra em `dashboard.stripe.com`; o acesso é por login link de uso único
  gerado pela plataforma.
- Nova rota `POST /stores/:slug/connect/stripe/dashboard` (mesmas permissões do
  account link) devolvendo `{ url }`. Reaproveita `connect.schema.ts`.
- `retrieveAccountStatus` já lê a capability `transfers`; nada muda.

**Front**

- `recebimento.tsx`: no card de cartão, quando `transfersEnabled`, trocar/acrescentar o
  botão "Abrir painel de recebimentos" apontando para o login link. É o que substitui o
  dashboard completo que o núcleo tinha em Standard.

**Testes**

- e2e `connect.test.ts`: criação manda `controller.*` esperado e **não** manda `type`;
  rota de dashboard devolve url e respeita permissão de loja.
- unit `stripe-gateway.test.ts`: `createConnectedAccount` monta o payload certo (mock já
  existe, é só somar `accountsCreate`).

## Fase 2 — doação mensal vira destination charge ✅ ENTREGUE

O ponto delicado não é a chamada, é o roteamento de webhook.

**Gateway** (`createDonationSubscription`)

- Sem `stripeAccount`: customer, product e subscription nascem na **plataforma**.
- `transfer_data: { destination: accountId }` + `application_fee_percent`.
- **Sem `on_behalf_of`** — plataforma é MoR (plataforma e núcleos todos no BR, mesma
  região, então não cai na exceção cross-border que obrigaria o parâmetro).
- `payment_behavior: "default_incomplete"` e `expand: ["latest_invoice.confirmation_secret"]`
  seguem iguais.
- `price_data` de subscription continua exigindo um Product existente — agora na
  plataforma. Criar um Product por loja e guardar o id (coluna nova
  `stripeDonationProductId` em `Store`, preenchida sob demanda) em vez de um Product novo
  por doação, que hoje entope a conta conectada com lixo.
- `cancelSubscription` perde o parâmetro `connectedAccountId`.

**Roteamento de webhook** — aqui mora o risco

Hoje `event.account` separa Connect de plataforma (ADR-021). Depois desta fase, a
assinatura SaaS da loja **e** as assinaturas de doação chegam as duas na plataforma, com
os mesmos tipos de evento (`customer.subscription.*`, `invoice.paid`). Regra nova, na
ordem:

1. `metadata.donationId` presente (ou `subscriptionRef` conhecido na tabela de doações)
   ⇒ fluxo de doação.
2. senão ⇒ fluxo de billing SaaS.

A metadata já viaja hoje (`metadata: { donationId, paymentId }`); o que falta é garantir
que ela viaje também em `subscription_data` para sobreviver ao ciclo, e que o
`billing-webhook` não trate uma assinatura de doação como assinatura de loja. Sem isso, o
efeito é uma doação mensal derrubando o status da assinatura SaaS da loja — o pior bug
possível desta fase, e o primeiro teste a escrever.

**Migração de dados**

Assinaturas mensais que já existem vivem na conta conectada e não migram: a Stripe não
move subscription entre contas. Duas saídas — (a) manter o branch legado de cancelamento
enquanto elas existirem, marcadas por uma coluna `subscriptionAccountId` na doação;
(b) cancelar e pedir re-assinatura. Hoje, em desenvolvimento, **não há nenhuma** doação
mensal viva, então (b) é grátis; em produção seria (a).

**Testes**

- `donations-monthly.test.ts`: assinatura criada sem `stripeAccount`, com `transfer_data`
  e `application_fee_percent`; `invoice.paid` sem `event.account` vira doação e **não**
  toca em `StoreSubscription`; e o inverso — `invoice.paid` da assinatura SaaS não cria
  doação.
- `donations-refunds.test.ts`: refund de ciclo mensal passa pelo mesmo caminho com
  `reverse_transfer`.

## Fase 3 — migrar as contas que já existem

**A Stripe não converte o tipo de uma conta.** `controller.stripe_dashboard.type` é
imutável. O caminho é criar conta nova na configuração nova e re-onboardar, gravando
`metadata.migrated_from_account_id` com o id antigo (registra a associação; **não** copia
dado nenhum).

Estado atual (verificado no sandbox em 2026-08-19): as duas contas conectadas que existem
lá são as de exemplo criadas pela própria Stripe; a conta da loja de desenvolvimento
(`acct_seed_demo`) é seed falso, não existe na Stripe. **Não há nada para migrar.** Então, hoje, "migração" é: trocar o código
da Fase 1, apagar a conta de sandbox, refazer o onboarding. Se este plano só for executado
depois do go-live, então vale o roteiro oficial: fases em lote, começando por um grupo
pequeno; aviso antecipado ao núcleo de que ele perde o dashboard completo e passa a ver
Express; prefill dos dados da conta antiga para encurtar o formulário; e a coluna
`stripeAccountId` guardando o id novo só quando o onboarding novo terminar, para não
derrubar quem ainda está vendendo pela conta velha.

## Fase 4 — embedded components ✅ ENTREGUE (onboarding + notification banner)

Recomendação do planner, não é bloqueio. `@stripe/connect-js` + Account Sessions para
trazer onboarding, saldo e pagamentos para dentro do `/gestao`, com `appearance` casando
com a identidade Tangerina (inclusive dark). Se for fazer, incluir sempre o
**notification banner**: é ele que avisa o núcleo quando a Stripe passa a exigir dado novo
e a conta corre risco de ser desabilitada.

## Fora deste plano, mas na lista

- **Platform Pricing Tool** no lugar do `application_fee_amount` calculado em bps. São
  mutuamente exclusivos: `application_fee_amount` na cobrança sobrescreve a ferramenta. Como
  a taxa hoje é por loja (`applicationFeeBps`), migrar só compensa se a regra virar única
  para todas as lojas.
- **Pix na Stripe**: destination charge suporta e vale o país da plataforma, mas conta BR é
  *invite only* (falar com o suporte) e **Pix Automático não existe no Brasil**. Doação
  recorrente por Pix segue impossível na Stripe ⇒ o Woovi continua no ar.

## ADRs afetados

- **ADR-016** (doação mensal usa direct charge) — superseded pela Fase 2.
- **ADR-020** (Connect standard, não express) — superseded pela Fase 1, e a consequência
  (b) precisa ser corrigida no texto: em destination charge a disputa sempre foi da
  plataforma.
- Novo ADR: contas com controller properties equivalentes a Express, e por que não
  Accounts v2 (o conflito `on_behalf_of` × marketplace).

## Ordem sugerida

Fase 0 (Dashboard, você) → Fase 1 → Fase 3 no modo barato (apagar sandbox, re-onboardar)
→ Fase 2. A Fase 2 por último porque é a que mexe em dinheiro recorrente e no roteamento
de webhook, e é melhor fazê-la com as contas já na configuração final.
