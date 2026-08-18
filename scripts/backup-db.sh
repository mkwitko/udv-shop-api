#!/usr/bin/env bash
# Backup diário do Postgres para o R2, com retenção de 30 dias.
#
# Agendar no cron do host da VM (não roda dentro do container):
#   10 3 * * * /opt/udv-shop-api/scripts/backup-db.sh >> /var/log/udv-backup.log 2>&1
#
# Requisitos no host: docker compose e aws-cli v2.
# Variáveis lidas do .env ao lado do docker-compose.prod.yml:
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BACKUP_BUCKET
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$COMPOSE_DIR"

# shellcheck disable=SC1091
set -a && source .env && set +a

: "${R2_ACCOUNT_ID:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}" "${R2_BACKUP_BUCKET:?}"

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
FILE="udvshop-${STAMP}.sql.gz"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"

docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U udv --no-owner udvshop | gzip >"/tmp/${FILE}"

aws s3 cp "/tmp/${FILE}" "s3://${R2_BACKUP_BUCKET}/${FILE}" --endpoint-url "$ENDPOINT"
rm -f "/tmp/${FILE}"

# retenção: apaga o que passou de 30 dias (nome carrega o timestamp UTC)
CUTOFF="$(date -u -d '30 days ago' +%Y-%m-%dT%H%M%SZ)"
aws s3 ls "s3://${R2_BACKUP_BUCKET}/" --endpoint-url "$ENDPOINT" |
  awk '{print $4}' |
  while read -r key; do
    [[ "$key" =~ ^udvshop-(.+)\.sql\.gz$ ]] || continue
    if [[ "${BASH_REMATCH[1]}" < "$CUTOFF" ]]; then
      aws s3 rm "s3://${R2_BACKUP_BUCKET}/${key}" --endpoint-url "$ENDPOINT"
    fi
  done

echo "backup ok: ${FILE}"
