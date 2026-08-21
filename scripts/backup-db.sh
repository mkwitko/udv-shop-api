#!/usr/bin/env bash
# Backup do Postgres para o R2: dump custom, validado, cifrado.
#
# Agendado pelo systemd (udv-backup.timer, de hora em hora). Chamado também pelo deploy com
# --prefix predeploy, antes de aplicar migration.
#
# Uso: backup-db.sh [--prefix hourly|predeploy]
#
# Requisitos no host: docker compose, aws-cli v2, age, curl, pg_restore (postgresql-client).
# Lidas do .env ao lado do compose:
#   POSTGRES_BACKUP_PASSWORD, R2_ACCOUNT_ID, R2_BACKUP_BUCKET,
#   R2_BACKUP_ACCESS_KEY_ID, R2_BACKUP_SECRET_ACCESS_KEY,
#   BACKUP_AGE_RECIPIENT, BACKUP_HEALTHCHECK_URL (opcional)
set -euo pipefail

PREFIX="hourly"
if [[ "${1:-}" == "--prefix" ]]; then
  PREFIX="${2:?--prefix exige um valor}"
fi

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$COMPOSE_DIR"

# shellcheck disable=SC1091
set -a && source .env && set +a

: "${POSTGRES_BACKUP_PASSWORD:?}" "${R2_ACCOUNT_ID:?}" "${R2_BACKUP_BUCKET:?}" \
  "${R2_BACKUP_ACCESS_KEY_ID:?}" "${R2_BACKUP_SECRET_ACCESS_KEY:?}" "${BACKUP_AGE_RECIPIENT:?}"

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
BASE="udvshop-${STAMP}.dump"
TMP="$(mktemp -d)"
# shellcheck disable=SC2329  # chamada pelo trap
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# 1. Formato custom, não SQL puro: permite pg_restore -j (paralelo) e restore de uma
#    tabela só, que é o que salva o dia quando o problema é uma tabela e não o banco.
docker compose -f docker-compose.prod.yml exec -T \
  -e PGPASSWORD="$POSTGRES_BACKUP_PASSWORD" postgres \
  pg_dump -U udv_backup -d udvshop -Fc -Z6 --no-owner --no-acl >"$TMP/$BASE"

# 2. Dump truncado por disco cheio ou OOM "termina bem": só a leitura do índice do arquivo
#    prova que está inteiro. Sem este passo, o defeito aparece no dia do desastre.
pg_restore --list "$TMP/$BASE" >/dev/null

# 3. Impressão digital do arquivo em claro, para o ensaio de restore conferir.
sha256sum "$TMP/$BASE" | awk '{print $1}' >"$TMP/$BASE.sha256"

# 4. Cifra com chave pública: token do R2 vazado não vira dado de cliente. Não protege
#    contra invasão da VM — a VM já tem o banco em claro.
age -r "$BACKUP_AGE_RECIPIENT" -o "$TMP/$BASE.age" "$TMP/$BASE"

export AWS_ACCESS_KEY_ID="$R2_BACKUP_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_BACKUP_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

s3() { aws s3 "$@" --endpoint-url "$ENDPOINT"; }

s3 cp "$TMP/$BASE.age" "s3://${R2_BACKUP_BUCKET}/${PREFIX}/${BASE}.age"
s3 cp "$TMP/$BASE.sha256" "s3://${R2_BACKUP_BUCKET}/${PREFIX}/${BASE}.sha256"

# 5. Promoção por cópia: o primeiro backup do dia também vira daily, o primeiro do mês vira
#    monthly. Retenção de cada prefixo é lifecycle rule no R2 — o script não apaga nada, e
#    bucket lock impede que um token vazado apague por nós.
if [[ "$PREFIX" == "hourly" ]]; then
  for tier in "daily:$(date -u +%Y-%m-%d)" "monthly:$(date -u +%Y-%m)"; do
    dir="${tier%%:*}"
    marker="${tier##*:}"
    if ! s3 ls "s3://${R2_BACKUP_BUCKET}/${dir}/udvshop-${marker}" >/dev/null 2>&1; then
      s3 cp "s3://${R2_BACKUP_BUCKET}/hourly/${BASE}.age" "s3://${R2_BACKUP_BUCKET}/${dir}/${BASE}.age"
      s3 cp "s3://${R2_BACKUP_BUCKET}/hourly/${BASE}.sha256" "s3://${R2_BACKUP_BUCKET}/${dir}/${BASE}.sha256"
      echo "promovido para ${dir}/"
    fi
  done
fi

# 6. Ping de vida. A falha que importa não é o script errando — é o script parando de rodar,
#    e nada de dentro da VM percebe isso.
if [[ -n "${BACKUP_HEALTHCHECK_URL:-}" ]]; then
  curl -fsS -m 10 --retry 3 "$BACKUP_HEALTHCHECK_URL" >/dev/null
fi

echo "backup ok: ${PREFIX}/${BASE}.age ($(du -h "$TMP/$BASE.age" | cut -f1))"
