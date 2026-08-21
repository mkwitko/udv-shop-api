#!/usr/bin/env bash
# Checagem de 15 em 15 minutos: disco, containers e idade do backup. Um ping só, que falha
# se qualquer item falhar — é vigilância de VM única, não observabilidade de frota.
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$COMPOSE_DIR"

# shellcheck disable=SC1091
set -a && source .env && set +a

fail=0

DISK_PCT="$(df --output=pcent / | tail -1 | tr -d ' %')"
if [[ "$DISK_PCT" -ge 80 ]]; then
  echo "FALHOU: disco em ${DISK_PCT}%" >&2
  fail=1
else
  echo "ok: disco em ${DISK_PCT}%"
fi

PGSIZE="$(docker compose -f docker-compose.prod.yml exec -T \
  -e PGPASSWORD="${POSTGRES_BACKUP_PASSWORD:?}" postgres \
  psql -qtAX -U udv_backup -d udvshop -c "SELECT pg_size_pretty(pg_database_size('udvshop'))" |
  tr -d '[:space:]')"
echo "ok: banco com $PGSIZE"

for service in api postgres cloudflared; do
  cid="$(docker compose -f docker-compose.prod.yml ps -q "$service")"
  if [[ -z "$cid" ]]; then
    echo "FALHOU: $service não está rodando" >&2
    fail=1
    continue
  fi
  # Serviço sem healthcheck declarado reporta o estado do processo, não "healthy".
  state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid")"
  if [[ "$state" != "healthy" && "$state" != "running" ]]; then
    echo "FALHOU: $service em estado $state" >&2
    fail=1
  else
    echo "ok: $service $state"
  fi
done

export AWS_ACCESS_KEY_ID="${R2_BACKUP_ACCESS_KEY_ID:?}"
export AWS_SECRET_ACCESS_KEY="${R2_BACKUP_SECRET_ACCESS_KEY:?}"
export AWS_DEFAULT_REGION="auto"
LAST="$(aws s3 ls "s3://${R2_BACKUP_BUCKET:?}/hourly/" \
  --endpoint-url "https://${R2_ACCOUNT_ID:?}.r2.cloudflarestorage.com" |
  awk '{print $1" "$2}' | sort | tail -1)"
if [[ -z "$LAST" ]]; then
  echo "FALHOU: nenhum backup em hourly/" >&2
  fail=1
else
  AGE_MIN=$((($(date +%s) - $(date -u -d "$LAST" +%s)) / 60))
  if [[ "$AGE_MIN" -gt 120 ]]; then
    echo "FALHOU: backup mais recente tem ${AGE_MIN}min" >&2
    fail=1
  else
    echo "ok: backup de ${AGE_MIN}min atrás"
  fi
fi

if [[ "$fail" -eq 0 && -n "${HOST_CHECK_HEALTHCHECK_URL:-}" ]]; then
  curl -fsS -m 10 --retry 3 "$HOST_CHECK_HEALTHCHECK_URL" >/dev/null
fi

exit "$fail"
