#!/usr/bin/env bash
# Valida os dois composes sem subir nada. Erro de indentação ou variável obrigatória faltando
# aparece aqui, não no `up -d` da VM às onze da noite.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"

docker compose -f docker-compose.dev.yml config -q
echo "ok: docker-compose.dev.yml"

# Valores de fachada só para a interpolação: o config não conecta em nada.
prod_config() {
  env \
    API_IMAGE="ghcr.io/exemplo/udv-shop-api@sha256:0000000000000000000000000000000000000000000000000000000000000000" \
    POSTGRES_PASSWORD=x POSTGRES_APP_PASSWORD=x POSTGRES_MIGRATE_PASSWORD=x \
    POSTGRES_BACKUP_PASSWORD=x TUNNEL_TOKEN=x \
    docker compose -f docker-compose.prod.yml --env-file /dev/null config "$@"
}

prod_config -q
echo "ok: docker-compose.prod.yml"

# Porta publicada em produção é erro: quem expõe é o túnel.
if prod_config | grep -q "published:"; then
  echo "FALHOU: docker-compose.prod.yml publica porta no host" >&2
  exit 1
fi
echo "ok: nenhuma porta publicada em produção"
