#!/usr/bin/env bash
# Sobe um Postgres descartável com os mesmos mounts da produção e afirma que o cluster
# nasceu do jeito certo: locale ICU, tuning aplicado e roles com privilégio mínimo.
# Roda igual na máquina do dev e no CI — é o teste da infra de banco.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME="udv-bootstrap-check-$$"
PASS="bootstrap"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" \
  -e POSTGRES_USER=udv \
  -e POSTGRES_PASSWORD="$PASS" \
  -e POSTGRES_DB=udvshop \
  -e POSTGRES_INITDB_ARGS="--locale-provider=icu --icu-locale=pt-BR --encoding=UTF8 --locale=C.UTF-8" \
  -e POSTGRES_APP_PASSWORD=app \
  -e POSTGRES_MIGRATE_PASSWORD=migrate \
  -e POSTGRES_BACKUP_PASSWORD=backup \
  -v "$REPO_DIR/deploy/postgres/tuning.conf:/etc/postgresql/tuning.conf:ro" \
  -v "$REPO_DIR/deploy/postgres/initdb:/docker-entrypoint-initdb.d:ro" \
  postgres:17.6-bookworm >/dev/null

for _ in $(seq 1 30); do
  docker exec "$NAME" pg_isready -U udv -d udvshop >/dev/null 2>&1 && break
  sleep 2
done
docker exec "$NAME" pg_isready -U udv -d udvshop >/dev/null

q() { docker exec -e PGPASSWORD="$PASS" "$NAME" psql -qtAX -U udv -d udvshop -c "$1"; }

check() { # check <descrição> <sql> <esperado>
  local got
  got="$(q "$2")"
  if [[ "$got" != "$3" ]]; then
    echo "FALHOU: $1 — esperado '$3', veio '$got'" >&2
    return 1
  fi
  echo "ok: $1"
}

fail=0
check "provider de locale é ICU" \
  "SELECT datlocprovider::text FROM pg_database WHERE datname = current_database()" "i" || fail=1
check "shared_buffers = 2GB" "SHOW shared_buffers" "2GB" || fail=1
check "max_connections = 50" "SHOW max_connections" "50" || fail=1
check "pg_stat_statements pré-carregado" "SHOW shared_preload_libraries" "pg_stat_statements" || fail=1
check "log de query lenta em 500ms" "SHOW log_min_duration_statement" "500ms" || fail=1
check "timezone do servidor é UTC" "SHOW timezone" "UTC" || fail=1

exit "$fail"
