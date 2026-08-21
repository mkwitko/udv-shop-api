#!/usr/bin/env bash
# Trava o parser de .env dos scripts de host. O caso que motivou isto:
# `EMAIL_FROM=Colheita <nao-responda@colheita.app>` fazia `source .env` estourar e, pior,
# tudo abaixo dessa linha ficava sem carregar — o backup falhava com
# "POSTGRES_BACKUP_PASSWORD: parameter null or not set" sem explicar o porquê.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/load-env.sh
source "$REPO_DIR/scripts/load-env.sh"

TMP="$(mktemp -d)"
# shellcheck disable=SC2329  # chamada pelo trap
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

cat >"$TMP/.env" <<'FIXTURE'
# comentário no topo

PRIMEIRA=um
EMAIL_FROM=Colheita <nao-responda@colheita.app>
DEPOIS_DO_ANGULO=dois
COM_PIPE=a|b
COM_ESPACO=texto com espaco
COM_ASPAS="entre aspas"
COM_IGUAL=postgresql://u:p@h:5432/d?connection_limit=10&pool_timeout=20
COM_CERQUILHA=valor#nao-e-comentario
FIXTURE

fail=0
check() { # check <descrição> <valor-obtido> <esperado>
  if [[ "$2" != "$3" ]]; then
    echo "FALHOU: $1 — esperado '$3', veio '$2'" >&2
    fail=1
  else
    echo "ok: $1"
  fi
}

load_env "$TMP/.env" || {
  echo "FALHOU: load_env retornou erro" >&2
  exit 1
}

check "linha antes do < carrega" "${PRIMEIRA:-}" "um"
check "valor com < e > preservado" "${EMAIL_FROM:-}" "Colheita <nao-responda@colheita.app>"
check "linha DEPOIS do < carrega" "${DEPOIS_DO_ANGULO:-}" "dois"
check "valor com pipe preservado" "${COM_PIPE:-}" "a|b"
check "valor com espaço preservado" "${COM_ESPACO:-}" "texto com espaco"
check "aspas envolventes removidas" "${COM_ASPAS:-}" "entre aspas"
check "só o primeiro = separa" "${COM_IGUAL:-}" "postgresql://u:p@h:5432/d?connection_limit=10&pool_timeout=20"
check "# no meio do valor não vira comentário" "${COM_CERQUILHA:-}" "valor#nao-e-comentario"

exit "$fail"
