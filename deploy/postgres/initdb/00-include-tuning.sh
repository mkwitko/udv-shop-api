#!/usr/bin/env bash
# Roda uma vez, no initdb. Acrescenta um include ao postgresql.conf gerado, de modo que o
# tuning viva num arquivo versionado no repo em vez de numa lista de flags no compose.
#
# Por que include e não `-c config_file=`: apontar config_file obriga o arquivo a conter tudo,
# inclusive listen_addresses — esquecer isso faz o cluster subir escutando só localhost e o
# container da API não conecta. O include herda todos os defaults da imagem.
set -euo pipefail

CONF="${PGDATA}/postgresql.conf"
TUNING="/etc/postgresql/tuning.conf"

if [[ ! -f "$TUNING" ]]; then
  echo "aviso: $TUNING não montado; cluster fica com o tuning default" >&2
  exit 0
fi

if ! grep -q "include_if_exists = '${TUNING}'" "$CONF"; then
  printf "\n# tuning versionado no repo (deploy/postgres/tuning.conf)\ninclude_if_exists = '%s'\n" \
    "$TUNING" >>"$CONF"
fi
