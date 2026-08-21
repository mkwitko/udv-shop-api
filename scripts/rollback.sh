#!/usr/bin/env bash
# Volta a API para a imagem anterior. Troca as duas variáveis de lugar, então rodar duas
# vezes vai e volta — útil quando o problema aparece meia hora depois do deploy verde.
#
# NÃO desfaz migration. Se a migration for o problema, o caminho é o dump predeploy/ mais
# recente e o runbook de restore.
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$COMPOSE_DIR"

PREVIOUS="$(grep -E '^API_IMAGE_PREVIOUS=' .env | cut -d= -f2- || true)"
CURRENT="$(grep -E '^API_IMAGE=' .env | cut -d= -f2- || true)"

[[ -n "$PREVIOUS" ]] || {
  echo "sem API_IMAGE_PREVIOUS no .env: não há para onde voltar" >&2
  exit 1
}

sed -i "s|^API_IMAGE=.*|API_IMAGE=${PREVIOUS}|" .env
sed -i "s|^API_IMAGE_PREVIOUS=.*|API_IMAGE_PREVIOUS=${CURRENT}|" .env

docker compose -f docker-compose.prod.yml up -d api

status="none"
for _ in $(seq 1 40); do
  cid="$(docker compose -f docker-compose.prod.yml ps -q api)"
  status="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo none)"
  [[ "$status" == "healthy" ]] && break
  sleep 3
done

echo "rollback para $PREVIOUS — estado: $status"
[[ "$status" == "healthy" ]]
