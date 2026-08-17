# Decisões de arquitetura (ADRs) — udv-shop-api

Registro curto das decisões técnicas relevantes e o porquê. Formato: contexto,
decisão, consequências. Adicione um ADR novo sempre que uma decisão estrutural
mudar (ver skill `docs-sync`).

## ADR-001: Prisma em vez de Drizzle

**Contexto:** precisávamos escolher o ORM/query builder para o Postgres do
projeto.

**Decisão:** usar Prisma (`@prisma/client` + `prisma migrate`) em vez de
Drizzle. Foi um pedido explícito do produto, não uma escolha técnica nossa.

**Consequências:** migrations declarativas via `schema.prisma`, client
totalmente tipado gerado a partir do schema. Em troca, abrimos mão do SQL
mais "à mão" e de alguns recursos de performance que o Drizzle expõe mais
diretamente. O acesso ao Prisma fica isolado nos repositories
(`createXRepository(db)`) para não vazar `PrismaClient` pelas services.

## ADR-002: Zod + fastify-type-provider-zod (em vez de JSON Schema puro)

**Contexto:** o frontend usa Kubb para gerar um client HTTP tipado a partir da
especificação OpenAPI da API.

**Decisão:** todo schema de rota é escrito em Zod e plugado via
`fastify-type-provider-zod`, que gera o JSON Schema/OpenAPI automaticamente e
também faz a validação de request/serialização de response em runtime.

**Consequências:** um único schema serve três papéis (validação, tipo
TypeScript, documentação OpenAPI) — sem essa tríade divergir com o tempo. Toda
rota precisa de `operationId` estável, porque é o nome do método que o Kubb
gera no client; renomear `operationId` é uma mudança breaking para o
frontend.

## ADR-003: JWT EdDSA próprio + refresh rotativo (sem Cognito)

**Contexto:** era possível terceirizar autenticação para um serviço gerenciado
(ex.: Cognito, Auth0).

**Decisão:** implementar autenticação própria: access token JWT assinado com
EdDSA (chave própria, `src/lib/jwt.ts`), TTL curto (`ACCESS_TOKEN_TTL_S`), e
refresh token opaco rotativo persistido no banco (`RefreshToken`, família por
login, detecção de reuso revoga a família inteira).

**Consequências:** controle total sobre o formato do token, sem dependência
de infraestrutura de terceiro nem custo por usuário ativo. Em troca, a equipe
é responsável por manter a rotação de chaves (`scripts/generate-keys.ts`) e
a lógica de revogação/reuso corretas — esse é o ponto mais sensível do
sistema de auth e por isso tem cobertura de teste dedicada
(`tokens.service.test.ts`, `auth-refresh-logout.test.ts`).

## ADR-004: personas como modelo de permissão (não papéis crus)

**Contexto:** o sistema tem múltiplos perfis de acesso (admin da plataforma,
dono de loja, staff de loja, cliente) e vai crescer.

**Decisão:** rotas nunca checam papel bruto do banco diretamente; toda checagem
passa por uma `Persona` (`src/shared/permissions.ts`) derivada do usuário
(`platformAdmin` + papéis por loja). `config.permissions` das rotas referencia
personas (`{ any: ["customer"] }`), nunca strings de papel específicas de
tabela.

**Consequências:** a origem do papel pode mudar (hoje é só
`platformAdmin`; papéis por loja chegam no Plano 2) sem que nenhuma rota
precise ser reescrita — só o mapeamento em `personasOf()` muda. Toda rota
autenticada é obrigada a declarar `config.permissions` ou `config.public`;
esquecer os dois derruba a rota em runtime (`AUTH_NO_PERMISSIONS`), de
propósito.

## ADR-005: dois repositórios separados (API e frontend)

**Contexto:** era possível manter API e frontend num monorepo único.

**Decisão:** manter `udv-shop-api` e o frontend em repositórios Git
separados, com o client HTTP do frontend gerado a partir do OpenAPI publicado
pela API (via Kubb).

**Consequências:** deploys e versionamento independentes; o contrato entre os
dois é o OpenAPI (daí a rigidez do ADR-002 sobre `operationId`/schema). Em
compensação, mudanças que tocam os dois lados exigem coordenar duas PRs em vez
de uma só.

## ADR-006: criação de loja aberta a qualquer usuário autenticado, nasce `pending`

**Contexto:** lojas começam com estado `draft` (interna) ou `pending` (aguardando
ativação humana), e idealmente qualquer usuário autenticado deveria conseguir
criar uma. Mas ativação automática seria prematura (depende de billing/SaaS).

**Decisão:** `POST /stores` é protegida por `{ any: ["customer"] }` (qualquer
autenticado); loja nova nasce com `status: pending`. Ativação (transição para
`active`) exige `platform_admin`, até o Plano 6 adicionar automação de billing.

**Consequências:** loja criada fica invisível no catálogo público e em listagens
gerais até aprovação. Owner da loja pode editar draft, mas não ativar sozinho.
Reduz spam/phishing; facilita auditoria de novos sellers.

## ADR-007: slug de produto imutável após criação

**Contexto:** URLs de produto (`/stores/:slug/products/:productSlug`) precisam
ser estáveis para SEO (links antigos não quebram) e marketing (QR codes,
impressos).

**Decisão:** `slug` é gerado uma única vez na criação e nunca pode ser mudado.
Se o usuario quiser mudar slug, deve criar um novo produto e arquivar o antigo.

**Consequências:** garante URLs permanentes; evita complexidade de redirects
ou histórico de slugs. Usuário tem que refazer trabalho de configuração, mas
é a escolha certa a longo prazo.

## ADR-008: upload de imagem via presigned PUT R2, com whitelist de content-type

**Contexto:** precisamos armazenar imagens de produto em cloud storage (R2) sem
expor credenciais S3/R2 direto ao frontend.

**Decisão:** API gera uma presigned URL PUT válida por tempo curto (ex.: 15min),
com headers restritos (`content-type` whitelist, ex.: `image/jpeg`, `image/png`).
Frontend faz upload direto via PUT. Chave é namespaced: `stores/<storeId>/products/<productId>/<filename>`.

**Consequências:** frontend não conhece credenciais R2; API controla quotas/tipos
permitidos. Upload é rápido (não passa pela API). Filename é gerado pelo
frontend para garantir unicidade + tipo correto (ex.: UUID + `.jpg`).
Em caso de roubo de presigned URL, limite de tempo (`expirationSeconds`) e
whitelist de content-type mitigam dano.
