# Deploy e operação (VM Oracle + Cloudflare)

RPO ≤ 1h (backup horário, mais dump antes de cada deploy). RTO medido no ensaio semanal —
ver "Registro de DR" no fim.

## Peças

| Peça | Onde |
| --- | --- |
| Imagem | `Dockerfile`, `linux/arm64`, publicada no GHCR pelo `deploy.yml` |
| Compose de produção | `docker-compose.prod.yml` — api + postgres + cloudflared, zero porta publicada |
| Tuning do banco | `deploy/postgres/tuning.conf` (incluído no `postgresql.conf` no initdb) |
| Roles do banco | `deploy/postgres/initdb/01-roles.sh` — migrate / app / backup |
| Deploy | `scripts/deploy-image.sh` (chamado pelo CD) |
| Rollback | `scripts/rollback.sh` |
| Backup | `scripts/backup-db.sh` + `udv-backup.timer` (horário) |
| Restore | `scripts/restore-db.sh` (baixa, confere sha256 e decifra) |
| Ensaio de restore | `scripts/restore-check.sh` + `udv-restore-check.timer` (semanal) |
| Vigilância | `scripts/host-check.sh` + `udv-host-check.timer` (15min) |
| Testes de infra | `scripts/test/db-bootstrap-check.sh`, `scripts/test/compose-check.sh` (rodam no CI) |

## Passos manuais (uma vez, e não dá para automatizar)

1. **Criar os dois repos no GitHub** (`udv-shop-api`, `udv-shop-web`) e dar `git push`.
   Repo público: definir a variável `ARM_RUNNER=ubuntu-24.04-arm` em Settings > Variables
   para o build sair nativo (~4min). Repo privado sem plano pago: não definir nada — cai no
   QEMU (~20min) e funciona igual, só devagar.
2. **Criar a VM**: Oracle Cloud, shape Ampere A1 (arm64), imagem Ubuntu 24.04 LTS aarch64.
   Security list: só a 22 de entrada. Saída 443 liberada (é o que o túnel usa).
3. **Na VM**: instalar docker-ce + compose plugin, `awscli` v2 (aarch64), `age`, `curl`;
   criar swapfile de 4G; habilitar `unattended-upgrades` só para security. O usuário das
   units systemd é `ubuntu` — se o seu for outro, ajustar `User=` em `deploy/systemd/*.service`.
4. **Criar o túnel** no painel da Cloudflare (Networking > Tunnels), rota
   `api.<domínio>` → `http://api:3333`. Copiar o token para `TUNNEL_TOKEN`.
5. **Criar o bucket de backup** no R2, separado do de uploads, e um token escopado só a ele
   (`Workers R2 Storage Bucket Item Write`).
6. **Retenção e imunidade no bucket** — o lock é sempre mais curto que o lifecycle, senão a
   expiração automática bate no lock e o objeto nunca sai:
   ```sh
   npx wrangler r2 bucket lifecycle add <bucket> --prefix hourly/    --expire-days 2
   npx wrangler r2 bucket lifecycle add <bucket> --prefix daily/     --expire-days 30
   npx wrangler r2 bucket lifecycle add <bucket> --prefix monthly/   --expire-days 365
   npx wrangler r2 bucket lifecycle add <bucket> --prefix predeploy/ --expire-days 30
   npx wrangler r2 bucket lock add <bucket> --name hourly    --prefix hourly/    --retention-days 1
   npx wrangler r2 bucket lock add <bucket> --name daily     --prefix daily/     --retention-days 7
   npx wrangler r2 bucket lock add <bucket> --name monthly   --prefix monthly/   --retention-days 90
   npx wrangler r2 bucket lock add <bucket> --name predeploy --prefix predeploy/ --retention-days 7
   ```
   Conferir os nomes das flags com `npx wrangler r2 bucket lifecycle add --help` antes de
   rodar; a CLI muda de versão para versão.
7. **Gerar a chave de cifra**: `age-keygen -o .age-key` na VM, `chmod 600 .age-key`.
   Guardar a linha `# public key: age1...` em `BACKUP_AGE_RECIPIENT` **e** a chave privada
   num gerenciador de senhas fora da VM.
8. **Criar as checagens no healthchecks.io** (grátis), as três em modo **Simple** — não
   cron: as units usam `Persistent=true` e `RandomizedDelaySec`, então o horário derrapa de
   propósito e o modo cron alertaria por desvio. Períodos: backup 1h com grace de 30min,
   restore-check 7 dias com grace de 1 dia, host-check 15min com grace de 15min. As três
   URLs vão no `.env` (`BACKUP_`/`RESTORE_CHECK_`/`HOST_CHECK_HEALTHCHECK_URL`); o
   `scripts/alert.sh` escolhe qual usar pelo nome da unit que falhou.
9. **Monitor externo** em `https://api.<domínio>/health`.
10. **Domínio da plataforma no Worker**: acrescentar a rota em `wrangler.jsonc` do
    `udv-shop-web` (fica comentada lá) quando o domínio existir.

## Primeiro boot

```sh
sudo mkdir -p /opt/udv-shop && sudo chown "$USER" /opt/udv-shop
cd /opt/udv-shop
# copiar docker-compose.prod.yml, scripts/ e deploy/ (o CD faz isso a cada deploy)
cp /caminho/do/repo/.env.example .env && chmod 600 .env   # e preencher
docker login ghcr.io                                       # PAT com read:packages
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f api
```

`POSTGRES_INITDB_ARGS` e os roles só agem com o volume vazio. Se o cluster subir com a
collation errada, o conserto é: dump, `down -v`, `up -d`, restore. Conferir antes de haver
dado real:

```sh
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U udv -d udvshop -c "SELECT datlocprovider, datcollate FROM pg_database WHERE datname='udvshop'"
```

Esperado: `datlocprovider = i`. O teste `test/e2e/db-collation.test.ts` cobre o mesmo em dev
e CI.

Instalar os timers:

```sh
sudo cp deploy/systemd/* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now udv-backup.timer udv-restore-check.timer udv-host-check.timer
systemctl list-timers 'udv-*'
```

Mudança em qualquer arquivo de `deploy/systemd/` exige repetir esses quatro comandos — o CD
copia os arquivos, mas não recarrega o systemd.

## Deploy

Push na `main` (ou tag `v*`) → build arm64 → GHCR → o CD copia compose/scripts/deploy para a
VM e roda `scripts/deploy-image.sh <imagem@digest>`, que tira dump `predeploy/`, troca a
imagem e espera o healthcheck. Se não ficar `healthy` em ~2min, volta sozinho e o job falha.

À mão:

```sh
cd /opt/udv-shop && ./scripts/deploy-image.sh ghcr.io/<owner>/udv-shop-api@sha256:<digest>
```

## Rollback

```sh
cd /opt/udv-shop && ./scripts/rollback.sh     # rodar de novo desfaz o rollback
```

**Rollback de imagem não desfaz migration.** Por isso mudança destrutiva de schema (drop de
coluna, rename, `NOT NULL` em coluna existente) nunca sai no mesmo release que o código:
expand, deploy, migrate, e o contract no release seguinte. Quando a regra falhar, o caminho
é o dump `predeploy/` e a seção abaixo.

Worker do front: `pnpm exec wrangler rollback` no repo `udv-shop-web`.

## Restaurar backup

```sh
cd /opt/udv-shop
# 1. escolher o objeto
aws s3 ls "s3://$R2_BACKUP_BUCKET/daily/" --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
# 2. baixar, conferir sha256 e decifrar
./scripts/restore-db.sh daily/udvshop-2026-08-21T030000Z.dump.age /tmp/restore.dump
# 3. parar a API para ninguém escrever durante o restore
docker compose -f docker-compose.prod.yml stop api
# 4. recriar o banco e aplicar
PG="$(docker compose -f docker-compose.prod.yml ps -q postgres)"
docker exec "$PG" dropdb -U udv --if-exists udvshop
docker exec "$PG" createdb -U udv udvshop
docker cp /tmp/restore.dump "$PG:/tmp/restore.dump"
docker exec "$PG" pg_restore -U udv -d udvshop -j 4 --no-owner --no-acl /tmp/restore.dump
# 5. subir
docker compose -f docker-compose.prod.yml up -d api
curl -fsS https://api.<domínio>/health
```

Recriar o banco **não** recria os roles (eles são do cluster, não do banco), mas apaga os
GRANTs — sem este bloco a API sobe e leva 500 em toda query:

```sh
docker exec -i "$PG" psql -U udv -d udvshop <<'SQL'
ALTER SCHEMA public OWNER TO udv_migrate;
GRANT USAGE ON SCHEMA public TO udv_app, udv_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO udv_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO udv_app;
ALTER DEFAULT PRIVILEGES FOR ROLE udv_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO udv_app;
ALTER DEFAULT PRIVILEGES FOR ROLE udv_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO udv_app;
SQL
```

Restore de uma tabela só (o caso mais comum): `pg_restore -t products` no lugar do
`pg_restore` do passo 4. Os nomes de tabela no banco são snake_case (`stores`, `products`,
`orders`, `donations`, `payments`), não os nomes dos models do Prisma.

**`pg_restore` do host não serve**: costuma ser de versão mais velha que o servidor e recusa
o arquivo com `unsupported version (1.16) in file header`. Por isso todo comando de dump e
restore aqui roda dentro do container.

## Rodar segredo

1. gerar o novo valor; 2. editar `/opt/udv-shop/.env`; 3.
`docker compose -f docker-compose.prod.yml up -d` (recria o container que usa a variável);
4. revogar o antigo no provedor. Senha de role do Postgres muda com
`ALTER ROLE <role> PASSWORD '...'` **antes** de editar o `.env` — o `initdb` não roda de novo.

## Diagnóstico

```sh
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail 100 api
journalctl -u udv-backup -n 50 --no-pager
./scripts/host-check.sh
# query lenta
docker compose -f docker-compose.prod.yml exec postgres psql -U udv -d udvshop -c \
  "SELECT calls, round(mean_exec_time) ms, left(query, 80) FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10"
```

## Segredos no GitHub

Repo da API: `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH`
(`/opt/udv-shop`). Variável opcional: `ARM_RUNNER`. `GITHUB_TOKEN` já cobre o GHCR.

Repo do web: secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; variables
`VITE_API_URL`, `VITE_SITE_URL`, `VITE_STRIPE_PUBLISHABLE_KEY`. O e2e do CI do web faz
checkout do repo da API para subir a API com `DEV_FAKE_PAYMENTS=true` — os dois repos
precisam estar na mesma conta/organização, ou usar um PAT de leitura.

## Registro de DR

O ensaio semanal imprime o tempo do restore. Anotar aqui a cada ensaio manual e sempre que
o número mudar de ordem de grandeza:

| Data | Objeto restaurado | Tempo | Observação |
| --- | --- | --- | --- |

## Domínio próprio de loja (opcional)

A aplicação já resolve `Host` → loja e reescreve para `/loja/{slug}` no Worker (ADR-023).
Falta a infraestrutura:

1. Ativar **Cloudflare for SaaS** (custom hostnames) na zona da plataforma. Verificado em
   2026-08-19: disponível no plano Free, 100 custom hostnames incluídos, US$ 0,10 por
   hostname adicional (limite de 50.000).
2. Publicar um hostname alvo do CNAME — por exemplo `lojas.<domínio>` apontando para o
   Worker.
3. Na API, definir `CUSTOM_DOMAIN_TARGET` com esse alvo. Vazio desliga a feature: a tela de
   Configurações diz que não está liberada e as rotas recusam com `custom_domain_disabled`.
4. Para cada loja aprovada, registrar o hostname na Cloudflare (API de custom hostnames)
   para emitir o certificado. Sem isso o CNAME resolve mas o HTTPS falha — não anuncie a
   feature antes.
