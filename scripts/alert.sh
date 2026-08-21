#!/usr/bin/env bash
# Reporta falha de uma unit systemd ao check correspondente no healthchecks.
#
# Uso: alert.sh <nome-da-unit>       (o OnFailure= passa %n)
#
# Existe para o alerta cair no check certo: falha do host-check não pode marcar o check do
# backup como quebrado. Lê as URLs do mesmo .env que os outros scripts, em vez de duplicá-las
# num arquivo só para o systemd.
set -euo pipefail

UNIT="${1:?nome da unit que falhou}"

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$COMPOSE_DIR"

# shellcheck source=scripts/load-env.sh
source "$(dirname "${BASH_SOURCE[0]}")/load-env.sh"
load_env .env

case "$UNIT" in
  udv-backup.service) URL="${BACKUP_HEALTHCHECK_URL:-}" ;;
  udv-restore-check.service) URL="${RESTORE_CHECK_HEALTHCHECK_URL:-}" ;;
  udv-host-check.service) URL="${HOST_CHECK_HEALTHCHECK_URL:-}" ;;
  *)
    echo "unit desconhecida: $UNIT" >&2
    exit 1
    ;;
esac

if [[ -z "$URL" ]]; then
  echo "sem URL de healthcheck para $UNIT; falha não foi reportada" >&2
  exit 0
fi

curl -fsS -m 10 --retry 3 "${URL}/fail" >/dev/null
echo "falha de $UNIT reportada"
