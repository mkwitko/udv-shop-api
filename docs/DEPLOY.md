# Deploy da API (Oracle VM + Cloudflare)

## Peças

- **Imagem**: `Dockerfile` multi-stage (node 22-slim, pnpm). O container roda
  `prisma migrate deploy` antes de subir o servidor.
- **Compose de produção**: `docker-compose.prod.yml` (api + postgres 17 + volume).
  A API só escuta em `127.0.0.1:3333` — quem expõe é o proxy do host.
- **CI**: `.github/workflows/ci.yml` (biome + typecheck + vitest com Postgres de
  serviço + build) em todo push/PR.
- **CD**: `.github/workflows/deploy.yml` — build da imagem → GHCR → SSH na VM
  (`compose pull && up -d`). Dispara em push na `main` e em tags `v*`.
- **Backup**: `scripts/backup-db.sh` — `pg_dump | gzip` → R2, retenção 30 dias.

## Preparo da VM (uma vez)

1. Docker + compose plugin, aws-cli v2.
2. `mkdir -p /opt/udv-shop-api` e copiar `docker-compose.prod.yml` + `scripts/`.
3. Criar `.env` ao lado do compose com o conteúdo do `.env.example` preenchido
   (produção: `NODE_ENV=production`, `DEV_FAKE_PAYMENTS=false`) e mais:
   - `POSTGRES_PASSWORD` (senha do banco no compose)
   - `API_IMAGE=ghcr.io/<owner>/udv-shop-api:latest`
   - `R2_BACKUP_BUCKET` (bucket separado do de uploads)
4. `docker login ghcr.io` com um PAT read:packages.
5. Proxy reverso no host (caddy/nginx) de `api.dominio.com` → `127.0.0.1:3333`,
   com origin cert da Cloudflare; firewall só 443 + SSH.
6. Cron do backup:
   `10 3 * * * /opt/udv-shop-api/scripts/backup-db.sh >> /var/log/udv-backup.log 2>&1`

## Secrets no GitHub (repo da API)

| Secret | Uso |
| --- | --- |
| `DEPLOY_SSH_HOST` | IP/host da VM |
| `DEPLOY_SSH_USER` | usuário SSH |
| `DEPLOY_SSH_KEY` | chave privada (só para deploy) |
| `DEPLOY_PATH` | ex.: `/opt/udv-shop-api` |

`GITHUB_TOKEN` já cobre o push para o GHCR.

## Web (repo udv-shop-web)

- `deploy.yml` publica no Cloudflare Workers via wrangler: produção na `main`,
  preview (`wrangler versions upload`) em PR.
- Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- Variables: `VITE_API_URL`, `VITE_SITE_URL`, `VITE_STRIPE_PUBLISHABLE_KEY`.
- O e2e do CI do web faz checkout deste repo (`<owner>/udv-shop-api`) para subir
  a API com `DEV_FAKE_PAYMENTS=true` — os dois repos precisam estar na mesma
  conta/organização (ou trocar por um PAT com acesso de leitura).

## Domínio próprio de loja (opcional, pago)

A aplicação já resolve `Host` → loja e reescreve para `/loja/{slug}` no worker do front
(ADR-023). Falta a parte de infraestrutura, que custa dinheiro e não dá para provisionar
pelo código:

1. Ativar **Cloudflare for SaaS** (custom hostnames) na zona da plataforma. Verificado em
   2026-08-19: está disponível **no plano Free**, com **100 custom hostnames incluídos** e
   US$ 0,10 por hostname adicional (limite de 50.000). Ou seja, até 100 lojas com domínio
   próprio sai de graça — a nota anterior de que a feature dependia de plano pago estava
   errada.
2. Publicar um hostname que sirva de alvo do CNAME — por exemplo `lojas.colheita.app`
   apontando para o worker.
3. Na API, definir `CUSTOM_DOMAIN_TARGET` com esse alvo. **Vazio desliga a feature**: a
   tela de Configurações diz que não está liberada e as rotas recusam com
   `custom_domain_disabled`.
4. Para cada loja aprovada, registrar o hostname na Cloudflare (API de custom hostnames)
   para emitir o certificado. Sem isso o CNAME resolve mas o HTTPS falha.

A verificação de CNAME que a loja vê na tela é independente disso: ela só confirma que o
DNS aponta para o alvo. Enquanto o passo 4 não existir, o endereço funciona em HTTP mas
não em HTTPS — não anuncie a feature antes.
