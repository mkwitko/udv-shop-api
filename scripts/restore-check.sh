#!/usr/bin/env bash
# Ensaio semanal de restore: pega o backup mais recente do prefixo daily/, restaura num
# Postgres descartável e confere que o banco restaurado tem cara de banco.
#
# Cluster novo e não o de produção de propósito: é o cenário real de desastre (a VM se foi),
# e restaurar em cluster virgem também prova que o dump sobe num Postgres recém-nascido.
#
# Agendado pelo systemd (udv-restore-check.timer, semanal).
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$COMPOSE_DIR"

# shellcheck source=scripts/load-env.sh
source "$(dirname "${BASH_SOURCE[0]}")/load-env.sh"
load_env .env

: "${R2_ACCOUNT_ID:?}" "${R2_BACKUP_BUCKET:?}" "${R2_BACKUP_ACCESS_KEY_ID:?}" \
  "${R2_BACKUP_SECRET_ACCESS_KEY:?}" "${POSTGRES_BACKUP_PASSWORD:?}"

export AWS_ACCESS_KEY_ID="$R2_BACKUP_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_BACKUP_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

NAME="udv-restore-check"
TMP="$(mktemp -d)"
# shellcheck disable=SC2329  # chamada pelo trap
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

START="$(date +%s)"

# O objeto mais recente entre hourly/ e daily/, e não o daily/ mais recente: num desastre
# de verdade se restaura o backup mais novo que existir, que quase sempre é um hourly. O
# daily/monthly são retenção, não RPO — ensaiar só o daily mede o restore de um dump com
# até 24h de atraso e deixa o caminho realmente usado sem ensaio.
#
# O nome carrega timestamp ISO em UTC (udvshop-2026-08-21T205729Z.dump.age), então ordem
# alfabética do basename é ordem cronológica.
LATEST="$(for prefix in hourly daily; do
  aws s3 ls "s3://${R2_BACKUP_BUCKET}/${prefix}/" --endpoint-url "$ENDPOINT" |
    awk -v p="$prefix" '$4 ~ /\.dump\.age$/ {print $4 "\t" p "/" $4}'
done | sort -k1,1 | tail -1 | cut -f2)"
[[ -n "$LATEST" ]] || {
  echo "nenhum backup em hourly/ nem daily/" >&2
  exit 1
}
echo "ensaiando com $LATEST"

./scripts/restore-db.sh "$LATEST" "$TMP/dump"

docker run -d --name "$NAME" \
  -e POSTGRES_PASSWORD=ensaio \
  -e POSTGRES_INITDB_ARGS="--locale-provider=icu --icu-locale=pt-BR --encoding=UTF8 --locale=C.UTF-8" \
  postgres:17.6-bookworm >/dev/null

for _ in $(seq 1 30); do
  docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 2
done

docker exec -e PGPASSWORD=ensaio "$NAME" createdb -U postgres udvshop
docker cp "$TMP/dump" "$NAME:/tmp/dump"
docker exec -e PGPASSWORD=ensaio "$NAME" \
  pg_restore -U postgres -d udvshop -j 4 --no-owner --no-acl /tmp/dump

q() { docker exec -e PGPASSWORD=ensaio "$NAME" psql -qtAX -U postgres -d udvshop -c "$1"; }

fail=0

# só dígitos: se a tabela não existe, o psql devolve texto de erro e a comparação
# numérica abaixo se perderia num "integer expression expected" em vez da mensagem certa
MIGRATIONS="$(q 'SELECT count(*) FROM _prisma_migrations' 2>/dev/null | tr -dc '0-9')"
MIGRATIONS="${MIGRATIONS:-0}"
if [[ "$MIGRATIONS" -lt 1 ]]; then
  echo "FALHOU: banco restaurado sem migration registrada" >&2
  fail=1
fi

for table in stores products orders donations payments campaigns users outbox_events; do
  exists="$(q "SELECT to_regclass('public.${table}') IS NOT NULL")"
  if [[ "$exists" != "t" ]]; then
    echo "FALHOU: tabela ${table} não existe no banco restaurado" >&2
    fail=1
  fi
done

# Contagem viva contra restaurada, recortada pelo instante do dump.
#
# Comparar com a produção de agora é comparar com alvo móvel: toda loja criada depois do
# dump aparece como diferença e o ensaio fica vermelho por motivo nenhum. O corte é
# `created_at < instante do dump` — o dump não podia conter o que ainda não existia.
#
# O instante sai do nome do arquivo (udvshop-2026-08-21T210259Z.dump.age), que é UTC.
STAMP="$(basename "$LATEST" | sed -E 's/^udvshop-([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z\.dump\.age$/\1 \2:\3:\4+00/')"
# Valida o que saiu, não o que entrou: o `sed` devolve o nome intacto quando não casa, e
# qualquer nome fora do padrão viraria um recorte silenciosamente errado.
if [[ ! "$STAMP" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}\+00$ ]]; then
  echo "FALHOU: nome de backup fora do padrão, sem instante para recortar: $LATEST" >&2
  fail=1
  STAMP="epoch"
fi

LIVE_STORES="$(docker compose -f docker-compose.prod.yml exec -T \
  -e PGPASSWORD="$POSTGRES_BACKUP_PASSWORD" postgres \
  psql -qtAX -U udv_backup -d udvshop \
  -c "SELECT count(*) FROM stores WHERE created_at < '${STAMP}'::timestamptz" 2>/dev/null | tr -dc '0-9')"
LIVE_STORES="${LIVE_STORES:-0}"
RESTORED_STORES="$(q 'SELECT count(*) FROM stores' 2>/dev/null | tr -dc '0-9')"
RESTORED_STORES="${RESTORED_STORES:-0}"
if [[ "$RESTORED_STORES" -lt "$LIVE_STORES" ]]; then
  echo "FALHOU: produção tinha $LIVE_STORES loja(s) até $STAMP e o restore tem $RESTORED_STORES" >&2
  fail=1
fi

ELAPSED=$(($(date +%s) - START))
echo "restore em ${ELAPSED}s — migrations=$MIGRATIONS lojas=$RESTORED_STORES (produção até $STAMP=$LIVE_STORES)"
echo "este número é o RTO medido; anote no registro de DR do docs/DEPLOY.md"

if [[ "$fail" -eq 0 && -n "${RESTORE_CHECK_HEALTHCHECK_URL:-}" ]]; then
  curl -fsS -m 10 --retry 3 "$RESTORE_CHECK_HEALTHCHECK_URL" >/dev/null
fi

exit "$fail"
