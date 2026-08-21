#!/usr/bin/env bash
# Troca a imagem da API por uma nova, com dump antes e volta automática se não ficar de pé.
#
# Uso: deploy-image.sh ghcr.io/owner/udv-shop-api@sha256:...
#
# Chamado pelo CD via SSH. Digest e não tag: `latest` não diz para onde voltar.
set -euo pipefail

NEW_IMAGE="${1:?imagem com digest, ex.: ghcr.io/owner/udv-shop-api@sha256:...}"

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$COMPOSE_DIR"

CURRENT="$(grep -E '^API_IMAGE=' .env | cut -d= -f2- || true)"

# Rede de segurança da migration: rollback de imagem não desfaz schema, então o ponto de
# retorno tem que ser deste minuto, não da hora passada.
./scripts/backup-db.sh --prefix predeploy

if grep -qE '^API_IMAGE_PREVIOUS=' .env; then
  sed -i "s|^API_IMAGE_PREVIOUS=.*|API_IMAGE_PREVIOUS=${CURRENT}|" .env
else
  printf 'API_IMAGE_PREVIOUS=%s\n' "$CURRENT" >>.env
fi
sed -i "s|^API_IMAGE=.*|API_IMAGE=${NEW_IMAGE}|" .env

docker compose -f docker-compose.prod.yml pull api
docker compose -f docker-compose.prod.yml up -d api

echo "esperando healthcheck..."
status="none"
for _ in $(seq 1 40); do
  cid="$(docker compose -f docker-compose.prod.yml ps -q api)"
  status="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo none)"
  [[ "$status" == "healthy" ]] && break
  sleep 3
done

if [[ "$status" != "healthy" ]]; then
  echo "api não ficou saudável (estado: $status); voltando para $CURRENT" >&2
  docker compose -f docker-compose.prod.yml logs --tail 50 api >&2
  ./scripts/rollback.sh
  exit 1
fi

docker image prune -f >/dev/null
echo "deploy ok: $NEW_IMAGE"
