#!/usr/bin/env bash
# Baixa um backup do R2, confere a impressão digital e decifra.
#
# Uso: restore-db.sh <objeto-no-r2> <arquivo-de-saída>
#   restore-db.sh daily/udvshop-2026-08-21T030000Z.dump.age /tmp/restore.dump
#
# Deliberadamente NÃO restaura: separar "obter o dump" de "aplicar o dump" evita que um
# comando de emergência sobrescreva o banco de produção por um argumento errado. Quem
# aplica é o operador (runbook) ou o restore-check.sh, em cluster descartável.
set -euo pipefail

OBJECT="${1:?ex.: daily/udvshop-2026-08-21T030000Z.dump.age}"
OUT="${2:?caminho do arquivo .dump de saída}"

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$COMPOSE_DIR"

# shellcheck source=scripts/load-env.sh
source "$(dirname "${BASH_SOURCE[0]}")/load-env.sh"
load_env .env

: "${R2_ACCOUNT_ID:?}" "${R2_BACKUP_BUCKET:?}" "${R2_BACKUP_ACCESS_KEY_ID:?}" \
  "${R2_BACKUP_SECRET_ACCESS_KEY:?}" "${BACKUP_AGE_KEY_FILE:?}"

[[ -r "$BACKUP_AGE_KEY_FILE" ]] || {
  echo "chave privada ilegível em $BACKUP_AGE_KEY_FILE" >&2
  exit 1
}

export AWS_ACCESS_KEY_ID="$R2_BACKUP_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_BACKUP_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

TMP="$(mktemp -d)"
# shellcheck disable=SC2329  # chamada pelo trap
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

aws s3 cp "s3://${R2_BACKUP_BUCKET}/${OBJECT}" "$TMP/dump.age" --endpoint-url "$ENDPOINT"
aws s3 cp "s3://${R2_BACKUP_BUCKET}/${OBJECT%.age}.sha256" "$TMP/dump.sha256" \
  --endpoint-url "$ENDPOINT"

age -d -i "$BACKUP_AGE_KEY_FILE" -o "$TMP/dump" "$TMP/dump.age"

EXPECTED="$(cat "$TMP/dump.sha256")"
ACTUAL="$(sha256sum "$TMP/dump" | awk '{print $1}')"
if [[ "$EXPECTED" != "$ACTUAL" ]]; then
  echo "sha256 não bate: esperado $EXPECTED, veio $ACTUAL" >&2
  exit 1
fi

# Confere que o arquivo é um dump legível antes de entregá-lo a quem vai restaurar. Roda no
# container e não no host: o pg_restore do host costuma ser mais velho que o servidor e
# recusa o header do arquivo ("unsupported version").
docker run --rm -v "$TMP:/w:ro" postgres:17.6-bookworm pg_restore --list /w/dump >/dev/null

mv "$TMP/dump" "$OUT"
echo "dump pronto em $OUT (sha256 confere)"
